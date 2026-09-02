use ratatui::style::Color;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Theme {
    /// Inherit the terminal's foreground, background, and ANSI palette.
    Terminal,
    /// GSV's curated palette for surfaces without a host terminal theme.
    Gsv,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Palette {
    pub(crate) background: Color,
    pub(crate) foreground: Color,
    pub(crate) muted: Color,
    pub(crate) quiet: Color,
    pub(crate) principal: Color,
    pub(crate) accent: Color,
    pub(crate) path: Color,
    pub(crate) warning: Color,
    pub(crate) error: Color,
    pub(crate) code_background: Option<Color>,
}

impl Theme {
    pub(crate) fn palette(self) -> Palette {
        match self {
            Self::Terminal => Palette {
                background: Color::Reset,
                foreground: Color::Reset,
                muted: Color::DarkGray,
                quiet: Color::DarkGray,
                principal: Color::Green,
                accent: Color::Cyan,
                path: Color::Blue,
                warning: Color::Yellow,
                error: Color::Red,
                code_background: None,
            },
            Self::Gsv => Palette {
                background: Color::Rgb(8, 9, 11),
                foreground: Color::Rgb(232, 230, 222),
                muted: Color::Rgb(105, 108, 116),
                quiet: Color::Rgb(61, 64, 70),
                principal: Color::Rgb(142, 201, 164),
                accent: Color::Rgb(151, 170, 255),
                path: Color::Rgb(190, 164, 232),
                warning: Color::Rgb(244, 190, 108),
                error: Color::Rgb(241, 126, 126),
                code_background: Some(Color::Rgb(18, 20, 24)),
            },
        }
    }
}
