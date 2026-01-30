mod bash;

pub use bash::BashTool;

use crate::protocol::ToolDefinition;
use serde_json::Value;

pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    fn execute(&self, args: Value) -> Result<Value, String>;
}

pub fn all_tools() -> Vec<Box<dyn Tool>> {
    vec![Box::new(BashTool)]
}
