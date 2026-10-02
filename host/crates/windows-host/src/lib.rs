//! Windows host ownership: SCM, process trees and private helper pipes.
#![cfg(windows)]
pub mod pipe;
pub mod process;
pub mod security;
pub mod service;
