use std::{ffi::c_void, io, mem, ptr};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACL,
        Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
        GetTokenInformation, INHERIT_ONLY_ACE, IsValidAcl, IsValidSid, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, TOKEN_QUERY,
        TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_SHARE_READ, FileDispositionInfo, FileRenameInfo, GetDriveTypeW,
        GetFileInformationByHandle, OPEN_EXISTING, READ_CONTROL, SetFileInformationByHandle,
        WriteFile,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn denied() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn handle(raw: HANDLE) -> io::Result<Handle> {
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(Handle(raw))
    }
}

fn user_token() -> io::Result<(Handle, Vec<u64>)> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = handle(token)?;
        let mut size = 0;
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
        if size < mem::size_of::<TOKEN_USER>() as u32 || size > 65536 {
            return Err(denied());
        }
        let mut bytes = vec![0u64; (size as usize).div_ceil(8)];
        if GetTokenInformation(
            token.0,
            TokenUser,
            bytes.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((token, bytes))
    }
}

fn verify_private_acl(directory: HANDLE, protected: bool) -> io::Result<()> {
    unsafe {
        let (_token, token_data) = user_token()?;
        let user = (*(token_data.as_ptr().cast::<TOKEN_USER>())).User.Sid;
        if user.is_null() {
            return Err(denied());
        }
        let mut owner: PSID = ptr::null_mut();
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut raw_sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let code = GetSecurityInfo(
            directory,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut raw_sd,
        );
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let _sd = SecurityDescriptor(raw_sd);
        let mut control = 0;
        let mut revision = 0;
        if raw_sd.is_null()
            || owner.is_null()
            || dacl.is_null()
            || EqualSid(owner, user) == 0
            || GetSecurityDescriptorControl(raw_sd, &mut control, &mut revision) == 0
            || (protected && control & SE_DACL_PROTECTED == 0)
            || IsValidAcl(dacl) == 0
            || (*dacl).AceCount != 1
        {
            return Err(denied());
        }
        let mut ace: *mut c_void = ptr::null_mut();
        if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
            return Err(denied());
        }
        let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
        let header = (*allowed).Header;
        // Reject complex ACEs and malformed SIDs before passing them to EqualSid.
        if header.AceType != 0
            || header.AceSize < 16
            || (protected
                && (u32::from(header.AceFlags) & OBJECT_INHERIT_ACE == 0
                    || u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0))
        {
            return Err(denied());
        }
        let sid = ptr::addr_of_mut!((*allowed).SidStart).cast::<u8>();
        let count = *sid.add(1) as usize;
        if 8 + count * 4 > header.AceSize as usize - 8
            || IsValidSid(sid.cast()) == 0
            || EqualSid(sid.cast(), user) == 0
        {
            return Err(denied());
        }
        Ok(())
    }
}

fn info(h: HANDLE) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut result = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(h, &mut result) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

/// Pins every directory component until dropped. Only existing local fixed-drive paths
/// and a deliberately strict private root are accepted; provisioning is not implemented.
pub struct Root {
    path: String,
    _parents: Vec<Handle>,
}
impl Root {
    pub fn open(path: &str) -> io::Result<Self> {
        let bytes = path.as_bytes();
        if bytes.len() < 4
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
            || path.contains('/')
            || path.contains('\0')
        {
            return Err(denied());
        }
        let components: Vec<_> = path[3..].split('\\').collect();
        if components.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.contains(':')
                || part.ends_with('.')
                || part.ends_with(' ')
        }) {
            return Err(denied());
        }
        let mut current = path[..3].to_string();
        if unsafe { GetDriveTypeW(wide(&current).as_ptr()) } != 3 {
            return Err(denied());
        }
        let mut parents = Vec::new();
        for part in std::iter::once("").chain(components.iter().copied()) {
            if !part.is_empty() {
                if !current.ends_with('\\') {
                    current.push('\\');
                }
                current.push_str(part);
            }
            let h = handle(unsafe {
                CreateFileW(
                    wide(&current).as_ptr(),
                    FILE_READ_ATTRIBUTES | READ_CONTROL,
                    FILE_SHARE_READ,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    ptr::null_mut(),
                )
            })?;
            let attributes = info(h.0)?.dwFileAttributes;
            if attributes & FILE_ATTRIBUTE_DIRECTORY == 0
                || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(denied());
            }
            parents.push(h);
        }
        verify_private_acl(parents.last().ok_or_else(denied)?.0, true)?;
        Ok(Self {
            path: current,
            _parents: parents,
        })
    }

    /// Creates a new single-component temporary file and keeps its handle open.
    pub fn create(&self, name: &str) -> io::Result<StagedFile<'_>> {
        if !super::safe_name(name) {
            return Err(denied());
        }
        let path = format!("{}\\{}", self.path, name);
        let h = handle(unsafe {
            CreateFileW(
                wide(&path).as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL,
                FILE_SHARE_READ,
                ptr::null(),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        })?;
        let checked = (|| {
            let file = info(h.0)?;
            if file.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                != 0
                || file.nNumberOfLinks != 1
            {
                return Err(denied());
            }
            verify_private_acl(h.0, false)
        })();
        if let Err(error) = checked {
            let _ = delete(h.0);
            return Err(error);
        }
        Ok(StagedFile {
            _root: self,
            handle: h,
        })
    }
}

pub struct StagedFile<'a> {
    _root: &'a Root,
    handle: Handle,
}
fn delete(h: HANDLE) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            h,
            FileDispositionInfo,
            ptr::addr_of!(disposition).cast(),
            mem::size_of_val(&disposition) as u32,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
impl StagedFile<'_> {
    pub fn write_all(&mut self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            let n = data.len().min(u32::MAX as usize) as u32;
            let mut written = 0;
            if unsafe {
                WriteFile(
                    self.handle.0,
                    data.as_ptr(),
                    n,
                    &mut written,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if written == 0 || written > n {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            data = &data[written as usize..];
        }
        Ok(())
    }

    /// Publishes the same held file without replacing an existing destination.
    pub fn publish(&mut self, name: &str) -> io::Result<()> {
        if !super::safe_name(name) || info(self.handle.0)?.nNumberOfLinks != 1 {
            return Err(denied());
        }
        let name: Vec<u16> = name.encode_utf16().collect();
        let offset = mem::offset_of!(FILE_RENAME_INFO, FileName);
        let length =
            (offset + name.len() * mem::size_of::<u16>()).max(mem::size_of::<FILE_RENAME_INFO>());
        let mut buffer = vec![0u64; length.div_ceil(mem::size_of::<u64>())];
        let rename = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            (*rename).Anonymous.ReplaceIfExists = false;
            (*rename).RootDirectory = self._root._parents.last().ok_or_else(denied)?.0;
            (*rename).FileNameLength = (name.len() * mem::size_of::<u16>()) as u32;
            ptr::copy_nonoverlapping(
                name.as_ptr(),
                ptr::addr_of_mut!((*rename).FileName).cast::<u16>(),
                name.len(),
            );
            if SetFileInformationByHandle(
                self.handle.0,
                FileRenameInfo,
                rename.cast(),
                length as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// Marks the held file for deletion; keep the handle if Windows refuses.
    pub fn release(&mut self) -> io::Result<()> {
        delete(self.handle.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;

    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn user_sid() -> String {
        let (_token, data) = user_token().unwrap();
        let user = unsafe { (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let mut text = ptr::null_mut();
        assert_ne!(unsafe { ConvertSidToStringSidW(user, &mut text) }, 0);
        let mut length = 0;
        unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }
        }
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).unwrap();
        unsafe {
            LocalFree(text.cast());
        }
        sid
    }
    fn private_temp() -> Temp {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("t3-peer-staging-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        let temp = Temp(path);
        let status = Command::new("icacls.exe")
            .arg(&temp.0)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("*{}:(OI)(CI)F", user_sid()))
            .status()
            .unwrap();
        assert!(
            status.success(),
            "icacls did not create a private test DACL"
        );
        temp
    }

    #[test]
    fn pins_parents_and_files_and_never_overwrites() {
        let temp = private_temp();
        let root = Root::open(temp.0.to_str().unwrap()).unwrap();
        assert!(fs::rename(&temp.0, temp.0.with_extension("moved")).is_err());
        let mut part = root.create("part").unwrap();
        part.write_all(b"binary\0data").unwrap();
        assert!(root.create("part").is_err());
        assert!(fs::write(temp.0.join("part"), b"replacement").is_err());
        let other = root.create("file").unwrap();
        drop(other);
        assert!(part.publish("file").is_err());
        fs::remove_file(temp.0.join("file")).unwrap();
        part.publish("file").unwrap();
        assert_eq!(fs::read(temp.0.join("file")).unwrap(), b"binary\0data");
        assert!(fs::remove_file(temp.0.join("file")).is_err());
        part.release().unwrap();
        drop(part);
        assert!(!temp.0.join("file").exists());
        drop(root);
    }

    #[test]
    fn rejects_untrusted_acl() {
        let temp = private_temp();
        let status = Command::new("icacls.exe")
            .arg(&temp.0)
            .arg("/grant")
            .arg("*S-1-1-0:(OI)(CI)R")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(Root::open(temp.0.to_str().unwrap()).is_err());
    }
}
