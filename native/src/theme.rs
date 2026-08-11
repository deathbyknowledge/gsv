use gpui::{rgb, Hsla};

pub const VOID: u32 = 0x07061a;
pub const TEXT: u32 = 0xf2f0ff;
pub const TEXT_QUIET: u32 = 0x817ba9;
pub const TEXT_FAINT: u32 = 0x4e496f;
pub const ACCENT: u32 = 0xb3aeff;
pub const LIVE: u32 = 0x8f8aff;
pub const ERROR: u32 = 0xff6f8c;
pub const APPROVAL: u32 = 0xf0c36a;
pub const SELECTION: u32 = 0x403b77;

pub const PROSE_FONT: &str = "Space Grotesk Light";
pub const MONO_FONT: &str = "Departure Mono";

pub fn color(value: u32) -> Hsla {
    rgb(value).into()
}
