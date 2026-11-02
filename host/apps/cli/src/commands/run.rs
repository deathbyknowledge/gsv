//! `gsv run`: one command on the Ship or a connected place, with its output
//! and exit status passed through. Ctrl-C stops the remote command.

use std::io::Write;

use gsv::kernel_client::GatewayAuth;
use serde_json::{json, Value};

use crate::remote::{self, opt_text, text, DynError, Exit, Output};
use crate::render::{self, Style, Tone};

fn write_output(result: &Value) -> Result<(), DynError> {
    let stdout = opt_text(result, "stdout");
    let stderr = opt_text(result, "stderr");
    if stdout.is_some() || stderr.is_some() {
        if let Some(stdout) = stdout {
            std::io::stdout().write_all(stdout.as_bytes())?;
        }
        if let Some(stderr) = stderr {
            std::io::stderr().write_all(stderr.as_bytes())?;
        }
    } else if let Some(output) = opt_text(result, "output") {
        std::io::stdout().write_all(output.as_bytes())?;
    }
    std::io::stdout().flush()?;
    Ok(())
}

fn exit_status(code: Option<i64>) -> u8 {
    code.and_then(|code| u8::try_from(code).ok()).unwrap_or(1)
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    on: Option<String>,
    cwd: Option<String>,
    command: Vec<String>,
    out: Output,
) -> Result<(), DynError> {
    let input = command.join(" ");
    let client = remote::connect(url, auth).await?;
    let target = remote::target_for(&client, on.as_deref()).await?;
    let mut args = json!({ "input": input });
    if let Some(target) = &target {
        args["target"] = json!(target);
    }
    if let Some(cwd) = cwd {
        args["cwd"] = json!(cwd);
    }

    let mut result = remote::call(&client, "shell.exec", args).await?;
    let mut collected = String::new();
    while text(&result, "status") == "running" {
        let session = text(&result, "sessionId").to_string();
        if out.json {
            collected.push_str(text(&result, "output"));
        } else {
            write_output(&result)?;
        }
        let mut poll = json!({ "sessionId": session, "input": "" });
        if let Some(target) = &target {
            poll["target"] = json!(target);
        }
        let next = tokio::select! {
            next = remote::call(&client, "shell.exec", poll) => next?,
            _ = tokio::signal::ctrl_c() => {
                let mut cancel = json!({ "sessionId": session });
                if let Some(target) = &target {
                    cancel["target"] = json!(target);
                }
                let _ = remote::call(&client, "shell.cancel", cancel).await;
                eprintln!("{}", Style::stderr().dim("Stopped."));
                return Err(Box::new(Exit(130)));
            }
        };
        result = next;
    }

    if out.json {
        collected.push_str(text(&result, "output"));
        let mut printed = result.clone();
        printed["output"] = json!(collected);
        render::print_json(&printed)?;
    } else {
        write_output(&result)?;
    }
    match text(&result, "status") {
        "completed" => {
            let code = remote::number(&result, "exitCode").unwrap_or(0);
            if code == 0 {
                Ok(())
            } else {
                Err(Box::new(Exit(exit_status(Some(code)))))
            }
        }
        _ => {
            if !out.json {
                let error = opt_text(&result, "error").unwrap_or("The command failed");
                eprintln!("{} {error}", Style::stderr().paint(Tone::Bad, "Error:"));
            }
            Err(Box::new(Exit(
                exit_status(remote::number(&result, "exitCode")).max(1),
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_statuses_pass_through_and_failures_are_never_zero() {
        assert_eq!(exit_status(Some(3)), 3);
        assert_eq!(exit_status(Some(-1)), 1);
        assert_eq!(exit_status(Some(512)), 1);
        assert_eq!(exit_status(None), 1);
    }
}
