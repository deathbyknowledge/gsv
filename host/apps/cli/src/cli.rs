use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

/// The top-level help, grouped by what a person wants to do. Clap cannot
/// group subcommands under headings, so the list is written out here; a test
/// keeps it in step with the visible commands.
pub(crate) const TOP_HELP: &str = "\
Ship from your terminal.

Usage: gsv <COMMAND> [--json]

Talk
  ship [MESSAGE]     Talk to your Ship, or open a prompt (also: chat)
  contacts           People you talk to, and invitations
  requests           Message requests from people you don't know yet
  mail               Your Ship's mailbox

Look after things
  work               What your Ship and its helpers are doing
  approvals          Actions waiting for your yes or no
  routines           Things your Ship does on a schedule
  memory             Your wiki, and the notes your Ship always reads
  activity           What ran, where, and how it went

Places
  files              Files on your Ship or a connected place
  run                Run one command on your Ship or a connected place
  places             Computers and browsers connected to your Ship

This computer
  login [SPACE]      Sign in to your Ship
  logout             Sign out
  status             Check sign-in, pairing and the background service
  pair CODE          Connect this computer to your Ship
  unpair             Disconnect this computer
  update             Check for a newer Ship for this computer
  desktop            Open Ship Desktop
  version            Show version and build details

Add --json to any command for the full result.
Run gsv help COMMAND for details, for example: gsv help files
";

#[derive(Parser)]
#[command(
    name = "gsv",
    bin_name = "gsv",
    version = gsv::build_info::BUILD_VERSION,
    about = "Ship from your terminal.",
    override_help = TOP_HELP,
    disable_help_subcommand = false
)]
pub(crate) struct Cli {
    /// Ship WebSocket URL; `gsv login SPACE` saves it instead
    #[arg(long, env = "GSV_URL", global = true, hide = true)]
    pub(crate) url: Option<String>,

    /// Account for a machine or service credential (legacy service units)
    #[arg(short = 'u', long, global = true, hide = true)]
    pub(crate) user: Option<String>,

    /// Non-interactive credential for CI and service units
    #[arg(
        short = 't',
        long,
        env = "GSV_TOKEN",
        global = true,
        hide = true,
        hide_env_values = true
    )]
    pub(crate) token: Option<String>,

    /// Print the full result as JSON
    #[arg(long, global = true)]
    pub(crate) json: bool,

    #[command(subcommand)]
    pub(crate) command: Option<Commands>,
}

#[derive(Subcommand)]
pub(crate) enum Commands {
    /// Talk to your Ship. With a message it sends once and prints the reply;
    /// without one it opens a prompt. Piped input counts as the message.
    #[command(visible_alias = "chat", args_conflicts_with_subcommands = true)]
    Ship {
        /// What to say (quotes are optional)
        #[arg(num_args = 0..)]
        message: Vec<String>,

        /// Removed: use `gsv work open`
        #[arg(long, hide = true)]
        pid: Option<String>,

        #[command(subcommand)]
        action: Option<ShipAction>,
    },

    /// Files on your Ship or a connected place. Name a place with
    /// PLACE:PATH, for example laptop:~/notes.txt; a bare path is on your Ship.
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },

    /// People you talk to, and invitations
    Contacts {
        #[command(subcommand)]
        action: Option<ContactsAction>,
    },

    /// Message requests from people you don't know yet
    Requests {
        #[command(subcommand)]
        action: Option<RequestsAction>,
    },

    /// Your wiki, and the notes your Ship always reads
    Memory {
        #[command(subcommand)]
        action: Option<MemoryAction>,
    },

    /// Your Ship's mailbox, newest first
    #[command(args_conflicts_with_subcommands = true)]
    Mail {
        #[command(flatten)]
        page: MailPage,

        #[command(subcommand)]
        action: Option<MailAction>,
    },

    /// What your Ship and its helpers are doing
    #[command(args_conflicts_with_subcommands = true)]
    Work {
        /// Include idle work
        #[arg(long)]
        all: bool,

        #[command(subcommand)]
        action: Option<WorkAction>,
    },

    /// Actions waiting for your yes or no
    Approvals {
        #[command(subcommand)]
        action: Option<ApprovalsAction>,
    },

    /// Things your Ship does on a schedule
    Routines {
        #[command(subcommand)]
        action: Option<RoutinesAction>,
    },

    /// Run one command on your Ship or a connected place. Output and the
    /// exit code pass through.
    Run {
        /// Place to run on (default: your Ship)
        #[arg(long)]
        on: Option<String>,

        /// Directory to run in
        #[arg(long)]
        cwd: Option<String>,

        /// The command line, for example: gsv run --on laptop df -h.
        /// Options for gsv itself, such as --json, go before it.
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },

    /// Computers and browsers connected to your Ship
    Places {
        #[command(subcommand)]
        action: Option<PlacesAction>,
    },

    /// What ran, where, and how it went
    Activity {
        /// Only what ran on this place
        #[arg(long)]
        on: Option<String>,

        /// How many entries to show
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: u32,
    },

    /// Sign in to your Ship, for example: gsv login me.ship.space
    Login {
        /// Your Ship's address (defaults to the last one you used)
        space: Option<String>,

        /// Account name, for root or another explicit account
        #[arg(long)]
        username: Option<String>,

        /// Password, for scripts (prefer the prompt)
        #[arg(long)]
        password: Option<String>,

        /// How long the session lasts, in hours
        #[arg(long, default_value_t = 8)]
        ttl_hours: u32,
    },

    /// Sign out and end this computer's session
    Logout,

    /// Check sign-in, pairing and the background service
    Status,

    /// Connect this computer to your Ship with an invitation (omit it to resume)
    Pair {
        /// Invitation (use - to read from stdin, omit to resume)
        code: Option<String>,
        /// Folder to share (defaults to your home folder)
        #[arg(long)]
        workspace: Option<PathBuf>,
        /// Save pairing without installing or starting the background service
        #[arg(long)]
        no_install: bool,
        /// Leave the CLI's selected Ship and login unchanged
        #[arg(long)]
        preserve_cli_login: bool,
        /// Refuse to replace an existing machine credential
        #[arg(long)]
        no_replace: bool,
    },

    /// Disconnect this computer from your Ship and remove its service
    Unpair {
        /// Don't ask for confirmation
        #[arg(long, short = 'y')]
        yes: bool,
    },

    /// Check for a newer Ship for this computer
    Update,

    /// Launch, focus, or control Ship Desktop
    Desktop {
        #[command(subcommand)]
        action: Option<DesktopAction>,
    },

    /// Show version and build details
    Version,

    /// Install, inspect, and control the local gsvd service
    #[command(hide = true)]
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    /// Compatibility command for already-installed legacy service definitions
    #[command(name = "device", hide = true)]
    LegacyDevice {
        #[command(subcommand)]
        action: LegacyDeviceAction,
    },

    /// Local CLI configuration (`--local`); the installers set the release channel here
    #[command(hide = true)]
    Config {
        /// Operate on the local CLI config
        #[arg(long)]
        local: bool,

        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Removed commands; each fails with a pointer to its replacement.
    #[command(hide = true, disable_help_flag = true)]
    Shell {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
        rest: Vec<String>,
    },
    #[command(hide = true, disable_help_flag = true)]
    Proc {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
        rest: Vec<String>,
    },
    #[command(hide = true, disable_help_flag = true)]
    Adapter {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
        rest: Vec<String>,
    },
    #[command(hide = true, disable_help_flag = true)]
    Auth {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
        rest: Vec<String>,
    },
}

impl Commands {
    /// The replacement for a removed command, printed instead of running it.
    /// The code in `gsv auth link CODE`, the one `auth` form that remains.
    pub(crate) fn link_code(rest: &[String]) -> Option<&str> {
        match rest {
            [link, code] if link == "link" && !code.starts_with('-') => Some(code),
            _ => None,
        }
    }

    pub(crate) fn removed_pointer(&self) -> Option<String> {
        fn first(rest: &[String]) -> &str {
            rest.first().map(String::as_str).unwrap_or_default()
        }
        let pointer = match self {
            Self::Shell { .. } => "`gsv shell` is now `gsv run`, for example: gsv run ls ~",
            Self::Proc { rest } => match first(rest) {
                "send" => "`gsv proc send` is now `gsv work open PID \"MESSAGE\"`.",
                "history" => "`gsv proc history` is now `gsv work show PID`.",
                "kill" | "reset" => {
                    "`gsv proc` is now `gsv work`; `gsv work stop PID` stops a run. Reset and end work from the web app."
                }
                _ => "`gsv proc` is now `gsv work`.",
            },
            Self::Adapter { .. } => {
                "`gsv adapter` was removed. Connect messengers in the web app, under Settings."
            }
            // A messenger's link challenge hands out a code to redeem here.
            Self::Auth { rest } if Self::link_code(rest).is_some() => return None,
            Self::Auth { rest } => match first(rest) {
                "login" => "`gsv auth login` is now `gsv login`, for example: gsv login me.ship.space",
                "logout" => "`gsv auth logout` is now `gsv logout`.",
                "token" => "`gsv auth token` was removed. Computers get their credentials from a pairing invitation (Work, then connect, in the web app), and `gsv places forget NAME` revokes one.",
                _ => "`gsv auth` was removed. Sign in with `gsv login`; link messengers in the web app, under Settings.",
            },
            Self::Ship { pid: Some(_), .. } => {
                "`gsv chat --pid` is now `gsv work open PID \"MESSAGE\"`."
            }
            Self::Config { local: false, .. } => {
                "`gsv config` was removed. Change settings in the web app, under Settings."
            }
            _ => return None,
        };
        Some(pointer.to_string())
    }
}

#[derive(Subcommand, Clone)]
pub(crate) enum ShipAction {
    /// Recent messages in your conversation
    History {
        /// How many messages to show
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: u32,
    },
    /// Find a past message
    Search {
        /// Words to find
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum FilesAction {
    /// List a folder (default: your Ship's home folder)
    Ls { path: Option<String> },
    /// Print a text file
    Cat { path: String },
    /// Upload a file from this computer
    Put {
        /// File on this computer
        local: PathBuf,
        /// Where to put it, such as notes/todo.md or laptop:~/todo.md
        path: String,
    },
    /// Download a file to this computer
    Get {
        path: String,
        /// Where to save it (default: the file's name in this folder; - prints it)
        local: Option<PathBuf>,
    },
    /// Copy a file between places without passing through this computer
    Cp { from: String, to: String },
    /// Delete a file
    Rm { path: String },
    /// Search file contents
    Search {
        /// Text to find
        query: String,
        /// Folder to search in (default: your Ship's home folder)
        path: Option<String>,
        /// Only files whose names match this pattern, such as *.md
        #[arg(long)]
        include: Option<String>,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum ContactsAction {
    /// Your conversations with contacts, newest first
    Inbox,
    /// Make an invitation to share with someone
    Invite {
        /// Days before the invitation expires
        #[arg(long)]
        days: Option<u32>,
    },
    /// Use an invitation someone shared with you
    Accept {
        /// The invitation link or code
        code: String,
    },
    /// Message a contact
    Send {
        /// Contact name
        name: String,
        /// What to say (quotes are optional)
        #[arg(required = true, num_args = 1..)]
        message: Vec<String>,
    },
    /// Block a contact
    Block { name: String },
    /// Unblock a contact
    Unblock { name: String },
}

#[derive(Subcommand, Clone)]
pub(crate) enum RequestsAction {
    /// Accept a message request
    Accept { id: String },
    /// Decline a message request
    Decline { id: String },
}

#[derive(Subcommand, Clone)]
pub(crate) enum MemoryAction {
    /// Print a wiki page, such as notes/index.md
    Read { page: String },
    /// Search your wikis
    Search {
        /// Words to find
        query: String,
        /// Only this wiki
        #[arg(long = "in")]
        wiki: Option<String>,
    },
    /// Show the notes your Ship reads in every conversation
    Standing,
}

#[derive(Args, Clone)]
pub(crate) struct MailPage {
    /// Show messages older than this one (from the previous page's footer)
    #[arg(long)]
    pub(crate) before: Option<String>,

    /// How many messages to show
    #[arg(short = 'n', long, default_value_t = 20)]
    pub(crate) limit: u32,
}

#[derive(Subcommand, Clone)]
pub(crate) enum MailAction {
    /// Search received mail
    Search {
        /// Words to find
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[command(flatten)]
        page: MailPage,
    },
    /// Read one message
    Read {
        /// Message id from the list
        id: String,
    },
    /// Send mail from your Ship's address; the body comes from MESSAGE or stdin
    Send {
        /// Recipient address
        to: String,
        /// Subject line
        #[arg(long, short = 's')]
        subject: Option<String>,
        /// Message body (default: read from stdin)
        #[arg(num_args = 0..)]
        message: Vec<String>,
    },
    /// Check a sent message's delivery
    Status {
        /// Delivery id printed by `gsv mail send`
        id: String,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum WorkAction {
    /// What a piece of work did
    Show {
        /// Work id from `gsv work`
        id: String,
        /// How many steps to show
        #[arg(short = 'n', long, default_value_t = 30)]
        limit: u32,
    },
    /// Talk to a piece of work, or open a prompt with it
    Open {
        /// Work id from `gsv work`
        id: String,
        /// What to say (quotes are optional)
        #[arg(num_args = 0..)]
        message: Vec<String>,
    },
    /// Stop what a piece of work is doing now
    Stop {
        /// Work id from `gsv work`
        id: String,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum ApprovalsAction {
    /// Allow one waiting action
    Allow {
        /// Id from `gsv approvals`
        id: String,
        /// Also allow actions like this from now on
        #[arg(long)]
        always: bool,
    },
    /// Refuse one waiting action
    Block {
        /// Id from `gsv approvals`
        id: String,
    },
}

#[derive(Args, Clone, Default)]
#[group(multiple = false)]
pub(crate) struct Cadence {
    /// Every day at this time, such as 09:00
    #[arg(long, value_name = "HH:MM")]
    pub(crate) daily: Option<String>,

    /// Every week on this day and time, such as "mon 09:00"
    #[arg(long, value_name = "DAY HH:MM")]
    pub(crate) weekly: Option<String>,

    /// At a fixed interval, such as 30m, 2h or 1d
    #[arg(long, value_name = "INTERVAL")]
    pub(crate) every: Option<String>,

    /// A cron expression, such as "0 9 * * 1-5"
    #[arg(long, value_name = "EXPR")]
    pub(crate) cron: Option<String>,
}

#[derive(Subcommand, Clone)]
pub(crate) enum RoutinesAction {
    /// Add a routine
    Add {
        /// A short name, such as "Morning briefing"
        name: String,
        /// What your Ship should do each time
        message: String,
        #[command(flatten)]
        cadence: Cadence,
        /// Time zone for daily, weekly and cron times (default: your Ship's)
        #[arg(long)]
        timezone: Option<String>,
    },
    /// Change a routine
    Edit {
        /// Routine id from `gsv routines`
        id: String,
        /// A new name
        #[arg(long)]
        name: Option<String>,
        /// What your Ship should do each time
        #[arg(long)]
        message: Option<String>,
        #[command(flatten)]
        cadence: Cadence,
        /// Time zone for daily, weekly and cron times
        #[arg(long)]
        timezone: Option<String>,
        /// Stop running it until resumed
        #[arg(long, conflicts_with = "resume")]
        pause: bool,
        /// Run it again on its schedule
        #[arg(long)]
        resume: bool,
    },
    /// Remove a routine
    Remove {
        /// Routine id from `gsv routines`
        id: String,
    },
    /// Run a routine now
    Run {
        /// Routine id from `gsv routines`
        id: String,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum PlacesAction {
    /// Give a place a new name
    Rename {
        /// Current name or id
        place: String,
        /// New name
        name: String,
    },
    /// Forget a place and revoke its access
    Forget {
        /// Name or id from `gsv places`
        place: String,
        /// Don't ask for confirmation
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub(crate) enum DesktopAction {
    /// Show redacted local Desktop state without launching it
    Status,

    /// Create and select a new conversation in Desktop
    New,

    /// Select an existing process in Desktop
    Use {
        /// Process ID to select
        pid: String,
    },

    /// List or select the microphone used for voice input
    Microphone {
        #[command(subcommand)]
        action: MicrophoneAction,
    },
}

#[derive(Subcommand)]
pub(crate) enum MicrophoneAction {
    /// List microphones and the current selection
    List,

    /// Select and remember a microphone by name
    Use {
        /// Microphone name to select
        name: String,
    },

    /// Use the operating system's default microphone
    Default,
}

#[derive(Subcommand)]
pub(crate) enum LegacyDeviceAction {
    /// Run gsvd in the foreground (compatibility launcher)
    Run {
        /// Device ID (default: device-<hostname>)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory for file tools
        #[arg(long)]
        workspace: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
pub(crate) enum DaemonAction {
    #[cfg(windows)]
    #[command(hide = true)]
    WindowsUpdate {
        #[arg(long)]
        daemon_sha256: String,
    },
    #[cfg(windows)]
    #[command(hide = true)]
    WindowsInstall {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        owner_sid: String,
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        daemon_source: PathBuf,
        #[arg(long)]
        daemon_sha256: String,
        #[arg(long, requires = "parent_pid")]
        transaction: Option<String>,
        #[arg(long, requires = "transaction")]
        parent_pid: Option<u32>,
    },
    /// Install and start the gsvd service
    Install {
        /// Machine ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Start the gsvd service
    Start,

    /// Restart the gsvd service
    Restart,

    /// Stop the gsvd service
    Stop,

    /// Uninstall and stop the gsvd service
    Uninstall,

    /// Show service state and live daemon status
    Status,

    /// Check the daemon executable and installed service definition
    Doctor,

    /// Ask the running daemon to reload config.toml and reconnect
    Reload,

    /// Reconnect the running daemon without changing configuration
    Reconnect,

    /// Show bounded, redacted live diagnostics
    Diagnostics,

    /// Show gsvd service logs
    Logs {
        /// Number of lines to show
        #[arg(short, long, default_value = "100")]
        lines: usize,

        /// Follow logs
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Subcommand)]
pub(crate) enum DaemonServiceAction {
    /// Install and start the gsvd service
    Install {
        /// Device ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Uninstall and stop the gsvd service
    Uninstall,

    /// Start the gsvd service
    Start,

    /// Restart the gsvd service
    Restart,

    /// Stop the gsvd service
    Stop,

    /// Show gsvd service status
    Status,

    /// Check the daemon executable and installed service definition
    Doctor,

    /// Show gsvd service logs
    Logs {
        /// Number of lines to show
        #[arg(short, long, default_value = "100")]
        lines: usize,

        /// Follow logs
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum ConfigAction {
    /// Get configuration value
    Get {
        /// Config key
        key: Option<String>,
    },
    /// Set configuration value
    Set {
        /// Config key
        key: String,
        /// Value to set
        value: String,
    },
}

#[derive(Subcommand)]
pub(crate) enum LocalConfigAction {
    /// Get a config value
    Get {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "device.token", "device.workspace")
        key: String,
    },
    /// Set a config value
    Set {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "device.token", "device.workspace")
        key: String,
        /// Value to set
        value: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Cli {
        match Cli::try_parse_from(args) {
            Ok(cli) => cli,
            Err(error) => panic!("{args:?} should parse: {error}"),
        }
    }

    #[test]
    fn top_help_lists_every_visible_command() {
        let command = Cli::command();
        for subcommand in command.get_subcommands() {
            if subcommand.is_hide_set() || subcommand.get_name() == "help" {
                continue;
            }
            let name = subcommand.get_name();
            assert!(
                TOP_HELP.contains(&format!("\n  {name} ")),
                "TOP_HELP is missing `{name}`"
            );
        }
        let help = Cli::try_parse_from(["gsv", "--help"])
            .err()
            .expect("help is displayed")
            .to_string();
        assert_eq!(help.trim_end(), TOP_HELP.trim_end());
    }

    #[test]
    fn plain_gsv_parses_without_a_command() {
        assert!(parse(&["gsv"]).command.is_none());
    }

    #[test]
    fn ship_sends_a_message_opens_a_prompt_or_reads_history() {
        let cli = parse(&["gsv", "ship", "what's", "on", "today?"]);
        assert!(
            matches!(cli.command, Some(Commands::Ship { message, action: None, .. })
            if message.join(" ") == "what's on today?")
        );
        let cli = parse(&["gsv", "chat"]);
        assert!(
            matches!(cli.command, Some(Commands::Ship { message, action: None, .. })
            if message.is_empty())
        );
        let cli = parse(&["gsv", "ship", "history", "-n", "5"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Ship {
                action: Some(ShipAction::History { limit: 5 }),
                ..
            })
        ));
        let cli = parse(&["gsv", "ship", "--json", "search", "dentist"]);
        assert!(cli.json);
    }

    #[test]
    fn removed_commands_parse_so_they_can_point_to_their_replacement() {
        for (args, expected) in [
            (vec!["gsv", "shell"], "gsv run"),
            (vec!["gsv", "proc", "list", "--uid", "1"], "gsv work"),
            (
                vec!["gsv", "proc", "send", "--pid", "p", "hi"],
                "gsv work open",
            ),
            (
                vec!["gsv", "adapter", "connect", "--adapter", "x"],
                "web app",
            ),
            (
                vec!["gsv", "auth", "login", "--username", "me"],
                "gsv login",
            ),
            (vec!["gsv", "auth", "token", "list"], "gsv places forget"),
            (vec!["gsv", "config", "get", "ai.model"], "web app"),
            (
                vec!["gsv", "chat", "--pid", "proc:1", "hi"],
                "gsv work open",
            ),
        ] {
            let cli = parse(&args);
            let pointer = cli
                .command
                .as_ref()
                .and_then(Commands::removed_pointer)
                .unwrap_or_default();
            assert!(pointer.contains(expected), "{args:?} -> {pointer}");
        }
        let local = parse(&["gsv", "config", "--local", "set", "release.channel", "dev"]);
        assert!(local
            .command
            .as_ref()
            .and_then(Commands::removed_pointer)
            .is_none());
    }

    #[test]
    fn login_takes_a_space_and_credentials_are_no_longer_global() {
        let cli = parse(&["gsv", "login", "me.ship.space", "--username", "root"]);
        assert!(
            matches!(cli.command, Some(Commands::Login { space: Some(space), username: Some(user), .. })
            if space == "me.ship.space" && user == "root")
        );
        Cli::try_parse_from(["gsv", "work", "-p", "secret"])
            .err()
            .expect("rejected");
        Cli::try_parse_from(["gsv", "work", "--password", "secret"])
            .err()
            .expect("rejected");
    }

    #[test]
    fn run_passes_the_command_line_through() {
        let cli = parse(&["gsv", "run", "--on", "laptop", "ls", "-la", "~"]);
        assert!(
            matches!(cli.command, Some(Commands::Run { on: Some(on), command, .. })
            if on == "laptop" && command == ["ls", "-la", "~"])
        );
        Cli::try_parse_from(["gsv", "run"]).err().expect("rejected");
    }

    #[test]
    fn mail_pages_with_before_and_routines_take_one_cadence() {
        let cli = parse(&["gsv", "mail", "--before", "abc123"]);
        assert!(
            matches!(cli.command, Some(Commands::Mail { page, action: None })
            if page.before.as_deref() == Some("abc123"))
        );
        let cli = parse(&["gsv", "mail", "search", "invoice", "--json"]);
        assert!(cli.json);
        parse(&[
            "gsv",
            "routines",
            "add",
            "Briefing",
            "Plan my day",
            "--daily",
            "08:00",
        ]);
        Cli::try_parse_from([
            "gsv", "routines", "add", "B", "M", "--daily", "08:00", "--every", "1h",
        ])
        .err()
        .expect("rejected");
    }

    #[test]
    fn pairing_keeps_every_flag_desktop_and_the_installers_use() {
        let pair = parse(&["gsv", "pair", "fixture-invitation", "--no-install"]);
        assert!(
            matches!(pair.command, Some(Commands::Pair { code: Some(code), no_install: true, .. })
            if code == "fixture-invitation")
        );
        let pair = parse(&["gsv", "pair", "-", "--preserve-cli-login", "--no-replace"]);
        assert!(
            matches!(pair.command, Some(Commands::Pair { code: Some(code), preserve_cli_login: true, no_replace: true, no_install: false, .. }) if code == "-")
        );
        let pair = parse(&["gsv", "pair", "--workspace", "/tmp/w"]);
        assert!(matches!(
            pair.command,
            Some(Commands::Pair {
                code: None,
                workspace: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn desktop_without_a_subcommand_means_activate() {
        let cli = parse(&["gsv", "desktop"]);
        assert!(matches!(
            cli.command,
            Some(Commands::Desktop { action: None })
        ));
    }

    #[test]
    fn desktop_commands_accept_only_the_narrow_control_surface() {
        let status = parse(&["gsv", "desktop", "status", "--json"]);
        assert!(status.json);
        assert!(matches!(
            status.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Status)
            })
        ));

        let new = parse(&["gsv", "desktop", "new"]);
        assert!(matches!(
            new.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::New)
            })
        ));

        let use_process = parse(&["gsv", "desktop", "use", "proc:1"]);
        assert!(matches!(
            use_process.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Use { pid })
            }) if pid == "proc:1"
        ));

        let microphone_list = parse(&["gsv", "desktop", "microphone", "list"]);
        assert!(matches!(
            microphone_list.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::List
                })
            })
        ));

        let microphone_use = parse(&["gsv", "desktop", "microphone", "use", "Shure MV6"]);
        assert!(matches!(
            microphone_use.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::Use { name }
                })
            }) if name == "Shure MV6"
        ));

        let microphone_default = parse(&["gsv", "desktop", "microphone", "default"]);
        assert!(matches!(
            microphone_default.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::Default
                })
            })
        ));

        Cli::try_parse_from(["gsv", "desktop", "send", "secret"])
            .err()
            .expect("rejected");
        Cli::try_parse_from(["gsv", "desktop", "new", "--label", "private"])
            .err()
            .expect("rejected");
        Cli::try_parse_from(["gsv", "desktop", "microphone"])
            .err()
            .expect("rejected");
        Cli::try_parse_from(["gsv", "desktop", "microphone", "use", "one", "two"])
            .err()
            .expect("rejected");
    }

    #[test]
    fn hidden_entry_points_used_by_installers_and_desktop_still_parse() {
        for args in [
            vec!["gsv", "daemon", "install"],
            vec!["gsv", "daemon", "install", "--workspace", "/tmp/w"],
            vec!["gsv", "daemon", "status"],
            vec!["gsv", "daemon", "uninstall"],
            vec!["gsv", "daemon", "doctor"],
            vec!["gsv", "daemon", "start"],
            vec!["gsv", "daemon", "stop"],
            vec!["gsv", "daemon", "reload"],
            vec!["gsv", "daemon", "diagnostics", "--json"],
            vec![
                "gsv",
                "config",
                "--local",
                "set",
                "release.channel",
                "stable",
            ],
            vec!["gsv", "device", "run"],
            vec![
                "gsv",
                "--url",
                "wss://x/ws",
                "-u",
                "owner",
                "-t",
                "t",
                "device",
                "run",
            ],
        ] {
            parse(&args);
        }
        #[cfg(windows)]
        parse(&["gsv", "daemon", "windows-update", "--daemon-sha256", "00"]);
    }

    #[test]
    fn daemon_owns_local_service_and_live_control_commands() {
        let status = parse(&["gsv", "daemon", "status"]);
        assert!(matches!(
            status.command,
            Some(Commands::Daemon {
                action: DaemonAction::Status
            })
        ));
        Cli::try_parse_from(["gsv", "daemon", "run"])
            .err()
            .expect("daemon run must not be public");
    }

    #[test]
    fn legacy_device_namespace_retains_only_the_installed_service_launcher() {
        Cli::try_parse_from(["gsv", "device", "status"])
            .err()
            .expect("legacy device status must be removed");
        Cli::try_parse_from(["gsv", "device", "install"])
            .err()
            .expect("legacy device install must be removed");
    }
}
