#[cfg(any(windows, feature = "windows-check"))]
fn main() -> std::io::Result<()> {
    use std::io::{self, BufRead, Read, Write};
    use t3_peer_staging::{protocol::Session, windows::Root};

    const MAX_LINE: u64 = 2 * 256 * 1024 + 64;
    let mut args = std::env::args().skip(1);
    let root_path = args.next().ok_or(io::ErrorKind::InvalidInput)?;
    let temporary_name = args.next().ok_or(io::ErrorKind::InvalidInput)?;
    let size = args
        .next()
        .ok_or(io::ErrorKind::InvalidInput)?
        .parse::<usize>()
        .map_err(|_| io::ErrorKind::InvalidInput)?;
    let hash = args.next().ok_or(io::ErrorKind::InvalidInput)?;
    if args.next().is_some()
        || size > 50 * 1024 * 1024
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let root = Root::open(&root_path)?;
    let file = root.create(&temporary_name)?;
    let mut session = Session::new(file, size, &hash)?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let run = (|| -> io::Result<()> {
        writeln!(output, "ready 1")?;
        output.flush()?;
        loop {
            let mut line = String::new();
            let bytes = (&mut input).take(MAX_LINE + 1).read_line(&mut line)?;
            if bytes == 0 {
                return Ok(());
            }
            if bytes as u64 > MAX_LINE || !line.ends_with('\n') {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line == "status" {
                let (state, offset) = session.status();
                writeln!(output, "status {state} {offset}")?;
                output.flush()?;
                continue;
            }
            let result = if let Some(args) = line.strip_prefix("write ") {
                if let Some((offset, hex)) = args.split_once(' ') {
                    let decoded = if hex.is_empty()
                        || hex.len() % 2 != 0
                        || hex.len() / 2 > 256 * 1024
                        || !hex.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        None
                    } else {
                        hex.as_bytes()
                            .chunks_exact(2)
                            .map(|pair| {
                                std::str::from_utf8(pair)
                                    .ok()
                                    .and_then(|s| u8::from_str_radix(s, 16).ok())
                            })
                            .collect::<Option<Vec<_>>>()
                    };
                    match (offset.parse::<usize>(), decoded) {
                        (Ok(offset), Some(data)) => session.write(offset, &data),
                        _ => Err(io::ErrorKind::InvalidInput.into()),
                    }
                } else {
                    Err(io::ErrorKind::InvalidInput.into())
                }
            } else if let Some(name) = line.strip_prefix("publish ") {
                session.publish(name)
            } else if line == "release" || line == "abort" {
                match session.cleanup() {
                    Ok(()) => {
                        writeln!(output, "ok cleanup-marked")?;
                        output.flush()?;
                        return Ok(());
                    }
                    Err(error) => Err(error),
                }
            } else {
                Err(io::ErrorKind::InvalidInput.into())
            };
            match result {
                Ok(()) => writeln!(output, "ok")?,
                Err(error) => {
                    let reason = match error.kind() {
                        io::ErrorKind::InvalidInput => "invalid",
                        io::ErrorKind::InvalidData => "integrity",
                        io::ErrorKind::AlreadyExists => "conflict",
                        _ => "storage",
                    };
                    writeln!(output, "error {reason}")?;
                }
            }
            output.flush()?;
        }
    })();
    // Report a failed deletion even when the input stream or its reader has failed.
    let cleanup = session.cleanup();
    if cleanup.is_err() {
        eprintln!("cleanup failed");
    }
    cleanup.and(run)
}

#[cfg(not(any(windows, feature = "windows-check")))]
fn main() {
    eprintln!("The experimental peer-staging worker requires Windows.");
    std::process::exit(1);
}
