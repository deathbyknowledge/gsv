use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or("Cannot locate the CLI installation")?;
    let mut command = Command::new(directory.join(format!("gsv{}", std::env::consts::EXE_SUFFIX)));
    command.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec().into())
    }
    #[cfg(windows)]
    {
        std::process::exit(command.status()?.code().unwrap_or(1));
    }
}
