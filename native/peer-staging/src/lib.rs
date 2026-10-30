//! Experimental Windows handle primitives. The receiver must remain disabled until its
//! lifetime, recovery and packaging are integrated and verified on Windows.

#[cfg(any(test, windows, feature = "windows-check"))]
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !matches!(
            name,
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        )
}

#[cfg(any(windows, feature = "windows-check"))]
pub mod windows;

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_are_single_unambiguous_windows_components() {
        for name in ["part", "file", "abc-123"] {
            assert!(safe_name(name));
        }
        for name in [
            "", ".", "..", "a/b", "a\\b", "a:b", "a.", "CON", "con", "lpt9", "a b", "ä",
        ] {
            assert!(!safe_name(name), "{name}");
        }
        assert!(!safe_name(&"a".repeat(129)));
    }
}
