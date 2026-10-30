use sha2::{Digest, Sha256};
use std::io;

const MAX_SIZE: usize = 50 * 1024 * 1024;
const MAX_CHUNK: usize = 256 * 1024;

pub trait Storage {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;
    fn matches_at(&mut self, offset: usize, data: &[u8]) -> io::Result<bool>;
    fn verify(&mut self, size: usize, hash: &str) -> io::Result<()>;
    fn publish(&mut self, name: &str) -> io::Result<()>;
    fn release(&mut self) -> io::Result<()>;
}

pub struct Session<S> {
    storage: S,
    expected_size: usize,
    expected_hash: String,
    hash: Sha256,
    written: usize,
    published: bool,
    poisoned: bool,
    released: bool,
}

impl<S: Storage> Session<S> {
    pub fn new(storage: S, expected_size: usize, expected_hash: &str) -> io::Result<Self> {
        if expected_size > MAX_SIZE
            || expected_hash.len() != 64
            || !expected_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(Self {
            storage,
            expected_size,
            expected_hash: expected_hash.into(),
            hash: Sha256::new(),
            written: 0,
            published: false,
            poisoned: false,
            released: false,
        })
    }

    pub fn write(&mut self, offset: usize, bytes: &[u8]) -> io::Result<()> {
        if self.published
            || self.poisoned
            || self.released
            || bytes.is_empty()
            || bytes.len() > MAX_CHUNK
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        if offset < self.written {
            if bytes.len() > self.written - offset {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            return match self.storage.matches_at(offset, bytes) {
                Ok(true) => Ok(()),
                Ok(false) => Err(io::ErrorKind::AlreadyExists.into()),
                Err(error) => {
                    self.poisoned = true;
                    Err(error)
                }
            };
        }
        if offset != self.written || bytes.len() > self.expected_size.saturating_sub(self.written) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        if let Err(error) = self.storage.write_all(bytes) {
            self.poisoned = true;
            return Err(error);
        }
        self.hash.update(bytes);
        self.written += bytes.len();
        Ok(())
    }

    pub fn status(&self) -> (&'static str, usize) {
        (
            if self.released {
                "released"
            } else if self.poisoned {
                "poisoned"
            } else if self.published {
                "published"
            } else {
                "receiving"
            },
            self.written,
        )
    }

    pub fn publish(&mut self, name: &str) -> io::Result<()> {
        if self.published
            || self.poisoned
            || self.released
            || self.written != self.expected_size
            || format!("{:x}", self.hash.clone().finalize()) != self.expected_hash
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if let Err(error) = self.storage.verify(self.expected_size, &self.expected_hash) {
            self.poisoned = true;
            return Err(error);
        }
        self.storage.publish(name)?;
        self.published = true;
        Ok(())
    }

    pub fn cleanup(&mut self) -> io::Result<()> {
        if !self.released {
            self.storage.release()?;
            self.released = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        data: Vec<u8>,
        published: bool,
        released: bool,
        fail_write: bool,
        collision: bool,
        fail_release: bool,
    }
    impl Storage for Fake {
        fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
            if self.fail_write {
                return Err(io::ErrorKind::WriteZero.into());
            }
            self.data.extend_from_slice(data);
            Ok(())
        }
        fn matches_at(&mut self, offset: usize, data: &[u8]) -> io::Result<bool> {
            Ok(self.data.get(offset..offset + data.len()) == Some(data))
        }
        fn publish(&mut self, _: &str) -> io::Result<()> {
            if self.collision {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            self.published = true;
            Ok(())
        }
        fn verify(&mut self, size: usize, hash: &str) -> io::Result<()> {
            if self.data.len() != size || format!("{:x}", Sha256::digest(&self.data)) != hash {
                return Err(io::ErrorKind::InvalidData.into());
            }
            Ok(())
        }
        fn release(&mut self) -> io::Result<()> {
            if self.fail_release {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            self.released = true;
            Ok(())
        }
    }
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn enforces_offsets_size_digest_and_no_overwrite() {
        let mut session = Session::new(Fake::default(), 3, ABC).unwrap();
        assert!(session.write(1, b"a").is_err());
        session.write(0, b"ab").unwrap();
        session.write(0, b"ab").unwrap();
        assert!(session.write(0, b"ax").is_err());
        assert!(session.write(1, b"bc").is_err());
        assert_eq!(session.status(), ("receiving", 2));
        assert!(session.publish("file").is_err());
        assert!(session.write(2, b"cd").is_err());
        session.write(2, b"c").unwrap();
        session.storage.collision = true;
        assert!(session.publish("file").is_err());
        session.storage.collision = false;
        session.publish("file").unwrap();
        assert_eq!(session.status(), ("published", 3));
        assert!(session.write(3, b"d").is_err());
        session.cleanup().unwrap();
        assert!(session.storage.released);
        let mut bad = Session::new(Fake::default(), 3, &"0".repeat(64)).unwrap();
        bad.write(0, b"abc").unwrap();
        assert!(bad.publish("file").is_err());
    }

    #[test]
    fn partial_write_failure_poisoning_prevents_publish_and_allows_cleanup() {
        let mut session = Session::new(
            Fake {
                fail_write: true,
                ..Fake::default()
            },
            3,
            ABC,
        )
        .unwrap();
        assert!(session.write(0, b"abc").is_err());
        assert!(session.publish("file").is_err());
        session.cleanup().unwrap();
    }

    #[test]
    fn changed_storage_prevents_publication_and_failed_cleanup_can_be_retried() {
        let mut session = Session::new(Fake::default(), 3, ABC).unwrap();
        session.write(0, b"abc").unwrap();
        session.storage.data[0] = b'x';
        assert!(session.publish("file").is_err());
        assert_eq!(session.status(), ("poisoned", 3));
        session.storage.fail_release = true;
        assert!(session.cleanup().is_err());
        assert_eq!(session.status(), ("poisoned", 3));
        session.storage.fail_release = false;
        session.cleanup().unwrap();
        assert_eq!(session.status(), ("released", 3));
    }
}
