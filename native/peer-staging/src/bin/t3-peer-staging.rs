#[cfg(any(windows, feature = "windows-check"))]
fn main() -> std::io::Result<()> {
    use std::io::{self, BufRead, Read, Write};
    use t3_peer_staging::windows::Root;

    const MAX_LINE: u64 = 2 * 256 * 1024 + 32;
    let mut args = std::env::args().skip(1);
    let root_path = args.next().ok_or(io::ErrorKind::InvalidInput)?;
    let temporary_name = args.next().ok_or(io::ErrorKind::InvalidInput)?;
    if args.next().is_some() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let root = Root::open(&root_path)?;
    let mut file = root.create(&temporary_name)?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "ready")?;
    output.flush()?;
    let mut published = false;
    let mut poisoned = false;
    let mut written = 0usize;
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
        let result = if let Some(hex) = line.strip_prefix("write ") {
            if published
                || poisoned
                || hex.is_empty()
                || hex.len() % 2 != 0
                || hex.len() / 2 > 256 * 1024
                || written + hex.len() / 2 > 50 * 1024 * 1024
                || !hex.bytes().all(|b| b.is_ascii_hexdigit())
            {
                Err(io::ErrorKind::InvalidInput.into())
            } else {
                let data: Result<Vec<u8>, _> = hex
                    .as_bytes()
                    .chunks_exact(2)
                    .map(|pair| {
                        let pair =
                            std::str::from_utf8(pair).map_err(|_| io::ErrorKind::InvalidData)?;
                        u8::from_str_radix(pair, 16).map_err(|_| io::ErrorKind::InvalidData)
                    })
                    .collect();
                let data = data?;
                match file.write_all(&data) {
                    Ok(()) => {
                        written += data.len();
                        Ok(())
                    }
                    Err(error) => {
                        poisoned = true;
                        Err(error)
                    }
                }
            }
        } else if let Some(name) = line.strip_prefix("publish ") {
            if published || poisoned {
                Err(io::ErrorKind::InvalidInput.into())
            } else {
                file.publish(name).map(|()| {
                    published = true;
                })
            }
        } else if line == "release" || line == "abort" {
            match file.release() {
                Ok(()) => {
                    writeln!(output, "ok")?;
                    output.flush()?;
                    return Ok(());
                }
                Err(error) => Err(error),
            }
        } else {
            Err(io::ErrorKind::InvalidInput.into())
        };
        writeln!(output, "{}", if result.is_ok() { "ok" } else { "error" })?;
        output.flush()?;
    }
}

#[cfg(not(any(windows, feature = "windows-check")))]
fn main() {
    eprintln!("The experimental peer-staging worker requires Windows.");
    std::process::exit(1);
}
