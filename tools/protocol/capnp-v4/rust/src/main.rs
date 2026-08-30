use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use gsv_capnp_v4_prototype::{
    decode_v4_binary_message, encode_v4_control_message, ControlFrame, V4BinaryMessage,
};
use serde::{Deserialize, Serialize};

struct CountingAllocator;

static ALLOCATION_CALLS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATION_CALLS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[derive(Deserialize)]
struct CorpusEntry {
    frame: ControlFrame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    runtime: String,
    corpus_frames: usize,
    iterations_per_round: usize,
    rounds: usize,
    formats: Formats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Formats {
    json_v3: FormatMetrics,
    capnp_unpacked: FormatMetrics,
    capnp_packed: FormatMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatMetrics {
    wire_bytes: usize,
    mean_wire_bytes: f64,
    encode: OperationMetrics,
    decode: OperationMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationMetrics {
    median_ns_per_frame: f64,
    allocation_calls_per_frame: f64,
    allocated_bytes_per_frame: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next().unwrap_or_default();
    match command.as_str() {
        "encode" => bridge_encode(arguments.any(|argument| argument == "--packed"))?,
        "decode" => bridge_decode(arguments.any(|argument| argument == "--packed"))?,
        "benchmark" => {
            let corpus_path = arguments.next().ok_or("benchmark requires a corpus path")?;
            let iterations = arguments
                .next()
                .map(|value| value.parse())
                .transpose()?
                .unwrap_or(1_000);
            benchmark(&corpus_path, iterations)?;
        }
        _ => {
            return Err(
                "usage: gsv-capnp-v4-prototype <encode|decode|benchmark> [--packed|CORPUS [ITERATIONS]]"
                    .into(),
            );
        }
    }
    Ok(())
}

fn bridge_encode(packed: bool) -> Result<(), Box<dyn std::error::Error>> {
    let frames: Vec<ControlFrame> = read_stdin_json()?;
    let encoded = frames
        .iter()
        .map(|frame| encode_v4_control_message(frame, packed).map(|bytes| BASE64.encode(bytes)))
        .collect::<Result<Vec<_>, _>>()?;
    write_stdout_json(&encoded)
}

fn bridge_decode(packed: bool) -> Result<(), Box<dyn std::error::Error>> {
    let encoded: Vec<String> = read_stdin_json()?;
    let frames = encoded
        .iter()
        .map(|value| {
            let bytes = BASE64.decode(value)?;
            match decode_v4_binary_message(&bytes)? {
                V4BinaryMessage::Control {
                    frame,
                    packed: actual_packed,
                } if actual_packed == packed => Ok(frame),
                V4BinaryMessage::Control { .. } => Err("unexpected control encoding".into()),
                V4BinaryMessage::Body { .. } => Err("expected a control message".into()),
            }
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    write_stdout_json(&frames)
}

fn benchmark(path: &str, iterations: usize) -> Result<(), Box<dyn std::error::Error>> {
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    let corpus: Vec<CorpusEntry> = serde_json::from_slice(&std::fs::read(path)?)?;
    let frames: Vec<_> = corpus.into_iter().map(|entry| entry.frame).collect();
    if frames.is_empty() {
        return Err("corpus must not be empty".into());
    }

    let json = frames
        .iter()
        .map(serde_json::to_vec)
        .collect::<Result<Vec<_>, _>>()?;
    let unpacked = frames
        .iter()
        .map(|frame| encode_v4_control_message(frame, false))
        .collect::<Result<Vec<_>, _>>()?;
    let packed = frames
        .iter()
        .map(|frame| encode_v4_control_message(frame, true))
        .collect::<Result<Vec<_>, _>>()?;

    for frame in &frames {
        black_box(serde_json::to_vec(frame)?);
        black_box(encode_v4_control_message(frame, false)?);
        black_box(encode_v4_control_message(frame, true)?);
    }
    for value in &json {
        black_box(serde_json::from_slice::<ControlFrame>(value)?);
    }
    for value in &unpacked {
        black_box(decode_carrier(value)?);
    }
    for value in &packed {
        black_box(decode_carrier(value)?);
    }

    const ROUNDS: usize = 9;
    let operations = iterations * frames.len();
    let json_encode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for frame in &frames {
                black_box(serde_json::to_vec(frame).expect("validated corpus"));
            }
        }
    });
    let json_decode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for value in &json {
                black_box(serde_json::from_slice::<ControlFrame>(value).expect("validated corpus"));
            }
        }
    });
    let capnp_encode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for frame in &frames {
                black_box(encode_v4_control_message(frame, false).expect("validated corpus"));
            }
        }
    });
    let capnp_decode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for value in &unpacked {
                black_box(decode_carrier(value).expect("validated corpus"));
            }
        }
    });
    let packed_encode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for frame in &frames {
                black_box(encode_v4_control_message(frame, true).expect("validated corpus"));
            }
        }
    });
    let packed_decode = measure(ROUNDS, operations, || {
        for _ in 0..iterations {
            for value in &packed {
                black_box(decode_carrier(value).expect("validated corpus"));
            }
        }
    });

    let report = BenchmarkReport {
        runtime: format!("rust {}", env!("CARGO_PKG_VERSION")),
        corpus_frames: frames.len(),
        iterations_per_round: iterations,
        rounds: ROUNDS,
        formats: Formats {
            json_v3: format_metrics(&json, json_encode, json_decode),
            capnp_unpacked: format_metrics(&unpacked, capnp_encode, capnp_decode),
            capnp_packed: format_metrics(&packed, packed_encode, packed_decode),
        },
    };
    write_stdout_json(&report)
}

fn format_metrics(
    encoded: &[Vec<u8>],
    encode: OperationMetrics,
    decode: OperationMetrics,
) -> FormatMetrics {
    let wire_bytes = encoded.iter().map(Vec::len).sum();
    FormatMetrics {
        wire_bytes,
        mean_wire_bytes: wire_bytes as f64 / encoded.len() as f64,
        encode,
        decode,
    }
}

fn decode_carrier(value: &[u8]) -> Result<ControlFrame, Box<dyn std::error::Error>> {
    match decode_v4_binary_message(value)? {
        V4BinaryMessage::Control { frame, .. } => Ok(frame),
        V4BinaryMessage::Body { .. } => Err("expected a control message".into()),
    }
}

fn measure(rounds: usize, operations: usize, mut operation: impl FnMut()) -> OperationMetrics {
    let mut timings = Vec::with_capacity(rounds);
    let mut allocation_calls = Vec::with_capacity(rounds);
    let mut allocated_bytes = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let calls_before = ALLOCATION_CALLS.load(Ordering::Relaxed);
        let bytes_before = ALLOCATED_BYTES.load(Ordering::Relaxed);
        let started = Instant::now();
        operation();
        let elapsed = started.elapsed().as_nanos() as f64 / operations as f64;
        let calls = ALLOCATION_CALLS.load(Ordering::Relaxed) - calls_before;
        let bytes = ALLOCATED_BYTES.load(Ordering::Relaxed) - bytes_before;
        timings.push(elapsed);
        allocation_calls.push(calls as f64 / operations as f64);
        allocated_bytes.push(bytes as f64 / operations as f64);
    }
    OperationMetrics {
        median_ns_per_frame: median(&mut timings),
        allocation_calls_per_frame: median(&mut allocation_calls),
        allocated_bytes_per_frame: median(&mut allocated_bytes),
    }
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn read_stdin_json<T: for<'de> Deserialize<'de>>() -> Result<T, Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input)?;
    Ok(serde_json::from_slice(&input)?)
}

fn write_stdout_json(value: &impl Serialize) -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    serde_json::to_writer_pretty(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
