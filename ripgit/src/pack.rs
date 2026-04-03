//! Git pack file parser and generator.
//!
//! Handles the binary pack format that git sends during `git push` and
//! expects to receive during `git fetch` / `git clone`.

use flate2::read::ZlibDecoder;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;

/// Packs larger than this are rejected before any objects are parsed.
/// Keeps peak memory to: body (≤50 MB) + cache (≤20 MB) + WASM/framework (~15 MB) ≈ 85 MB.
pub const MAX_PACK_BYTES: usize = 50_000_000;

/// Maximum total bytes held in the resolve cache at one time.
/// When full, new entries are skipped (processing continues with more re-decompression,
/// but never OOMs due to cache growth).
pub const CACHE_BUDGET_BYTES: usize = 20_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectType {
    Commit,
    Tree,
    Blob,
    Tag,
}

impl ObjectType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ObjectType::Commit => "commit",
            ObjectType::Tree => "tree",
            ObjectType::Blob => "blob",
            ObjectType::Tag => "tag",
        }
    }

    fn from_type_num(n: u8) -> Option<Self> {
        match n {
            1 => Some(ObjectType::Commit),
            2 => Some(ObjectType::Tree),
            3 => Some(ObjectType::Blob),
            4 => Some(ObjectType::Tag),
            _ => None,
        }
    }

    fn to_type_num(&self) -> u8 {
        match self {
            ObjectType::Commit => 1,
            ObjectType::Tree => 2,
            ObjectType::Blob => 3,
            ObjectType::Tag => 4,
        }
    }
}

/// A fully resolved pack object with type and data.
/// Used by `generate_into()` for fetch/clone and by `collect_objects()` in store.
#[derive(Debug)]
pub struct PackObject {
    pub obj_type: ObjectType,
    pub data: Vec<u8>,
}

/// Lightweight metadata for one entry in a pack file.
/// Does NOT hold decompressed data — just offsets and delta references.
pub struct PackEntryMeta {
    /// Byte offset where the zlib-compressed data starts (after header +
    /// any delta header bytes). Used for decompression.
    pub data_offset: usize,
    /// Raw type number: 1=commit, 2=tree, 3=blob, 4=tag, 6=ofs_delta, 7=ref_delta.
    pub type_num: u8,
    /// Decompressed size from the pack header. For non-delta entries this is
    /// the final object size; for deltas it's the delta payload size.
    pub size: usize,
    /// For OFS_DELTA (type 6): absolute byte offset of the base entry in the pack.
    pub base_pack_offset: Option<usize>,
    /// For REF_DELTA (type 7): hex SHA-1 hash of the base object.
    pub base_hash: Option<String>,
}

#[derive(Debug)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pack parse error: {}", self.0)
    }
}

type Result<T> = std::result::Result<T, ParseError>;

// ---------------------------------------------------------------------------
// Streaming pack parser — index + on-demand resolution
// ---------------------------------------------------------------------------

/// Build a lightweight index of all entries in a pack file.
///
/// Walks the pack byte stream, recording metadata (offsets, type, delta base
/// references) for each entry. Zlib data is decompressed to a sink (discarded)
/// only to determine entry boundaries — no object data is held in memory.
///
/// Returns `(index, offset_to_idx)` where `offset_to_idx` maps a pack byte
/// offset to the entry's index in the Vec. This is needed for OFS_DELTA
/// resolution.
pub fn build_index(data: &[u8]) -> Result<(Vec<PackEntryMeta>, HashMap<usize, usize>)> {
    if data.len() < 12 {
        return Err(ParseError("pack too short for header".into()));
    }
    if &data[0..4] != b"PACK" {
        return Err(ParseError("missing PACK signature".into()));
    }
    let version = read_u32_be(data, 4);
    if version != 2 && version != 3 {
        return Err(ParseError(format!("unsupported pack version {}", version)));
    }
    let num_objects = read_u32_be(data, 8) as usize;
    let mut pos = 12;

    let mut index = Vec::with_capacity(num_objects);
    let mut offset_to_idx: HashMap<usize, usize> = HashMap::with_capacity(num_objects);

    for _i in 0..num_objects {
        let entry_offset = pos;
        let (type_num, size, header_len) = read_type_and_size(data, pos)?;
        pos += header_len;

        let mut base_pack_offset = None;
        let mut base_hash = None;

        match type_num {
            // Regular objects: nothing extra to read before zlib data
            1 | 2 | 3 | 4 => {}
            // OFS_DELTA: variable-length negative offset, then zlib data
            6 => {
                let (offset, offset_len) = read_ofs_delta_offset(data, pos)?;
                pos += offset_len;
                base_pack_offset = Some(
                    entry_offset
                        .checked_sub(offset)
                        .ok_or_else(|| ParseError("OFS_DELTA offset underflow".into()))?,
                );
            }
            // REF_DELTA: 20-byte SHA-1 hash, then zlib data
            7 => {
                if pos + 20 > data.len() {
                    return Err(ParseError("REF_DELTA: truncated base hash".into()));
                }
                base_hash = Some(hex_encode(&data[pos..pos + 20]));
                pos += 20;
            }
            _ => {
                return Err(ParseError(format!("unknown object type {}", type_num)));
            }
        }

        let data_offset = pos;

        // Decompress to sink — we only need to know how many compressed bytes
        // were consumed so we can advance `pos` to the next entry.
        let consumed = zlib_skip(data, pos)?;
        pos += consumed;

        offset_to_idx.insert(entry_offset, index.len());
        index.push(PackEntryMeta {
            data_offset,
            type_num,
            size,
            base_pack_offset,
            base_hash,
        });
    }

    Ok((index, offset_to_idx))
}

/// Determine the final object type for a pack entry by following its
/// OFS_DELTA chain back to a non-delta base.
///
/// Returns `None` for REF_DELTA entries (type resolution requires hash
/// lookup, which isn't available from the index alone).
pub fn resolve_type(
    index: &[PackEntryMeta],
    offset_to_idx: &HashMap<usize, usize>,
    entry_idx: usize,
) -> Option<ObjectType> {
    let entry = &index[entry_idx];
    match entry.type_num {
        1..=4 => ObjectType::from_type_num(entry.type_num),
        6 => {
            let base_offset = entry.base_pack_offset?;
            let &base_idx = offset_to_idx.get(&base_offset)?;
            resolve_type(index, offset_to_idx, base_idx)
        }
        // REF_DELTA: can't follow without hash → index mapping
        _ => None,
    }
}

/// Bounded cache for resolved pack entries.  Avoids re-decompressing shared
/// delta chain bases — critical for git packs with deep chains (up to 50).
/// Keyed by entry index.
///
/// Entries are stored as `Arc<[u8]>` so cache hits return a pointer increment
/// rather than a full data copy.  Multiple entries sharing the same delta base
/// all hold an Arc clone — one allocation, many readers.
///
/// The cache enforces two independent limits:
///   - `max_entries`: caps the number of cached objects (index space)
///   - `budget`: caps total cached bytes (memory space)
/// When either limit is hit, new entries are silently skipped — processing
/// continues correctly via re-decompression, just without the cache speedup.
pub struct ResolveCache {
    entries: HashMap<usize, (ObjectType, Arc<[u8]>)>,
    max_entries: usize,
    budget: usize,       // maximum total bytes across all cached entries
    cached_bytes: usize, // current total bytes held in the cache
}

impl ResolveCache {
    pub fn new(max_entries: usize, budget: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(max_entries),
            max_entries,
            budget,
            cached_bytes: 0,
        }
    }

    /// Return a shared handle to the cached entry.  `Arc::clone` is a pointer
    /// increment — no data is copied regardless of object size.
    fn get(&self, idx: usize) -> Option<(ObjectType, Arc<[u8]>)> {
        self.entries.get(&idx).map(|(t, d)| (*t, Arc::clone(d)))
    }

    /// Maximum size of a single cached entry (10 MB). Entries larger than
    /// this are not cached — large blobs are unlikely to be delta bases and
    /// would exhaust the budget immediately.
    const MAX_ENTRY_SIZE: usize = 10_000_000;

    /// Cache an entry if it fits within both the per-entry size cap and the
    /// total byte budget.  Takes the Arc by value — caller constructs it once.
    fn try_cache(&mut self, idx: usize, obj_type: ObjectType, data: Arc<[u8]>) {
        if self.entries.len() < self.max_entries
            && data.len() <= Self::MAX_ENTRY_SIZE
            && self.cached_bytes + data.len() <= self.budget
        {
            self.cached_bytes += data.len();
            self.entries.insert(idx, (obj_type, data));
        }
    }

    fn contains(&self, idx: usize) -> bool {
        self.entries.contains_key(&idx)
    }

    /// How many bytes are currently held across all cached entries.
    /// Exposed for observability (e.g. stats endpoint, logging).
    #[allow(dead_code)]
    pub fn cached_bytes(&self) -> usize {
        self.cached_bytes
    }

    /// Drop all cached entries and reset the byte counter.
    pub fn clear(&mut self) {
        self.cached_bytes = 0;
        self.entries.clear();
    }
}

/// Resolve a single pack entry into its final (type, data) by decompressing
/// from the pack bytes and applying any delta chain.
///
/// Uses `cache` to avoid re-decompressing shared delta chain bases.  All
/// resolved entries (bases and intermediates) are cached up to the cache
/// capacity, so subsequent entries sharing the same base chain hit the cache
/// instead of re-decompressing from the pack bytes.
/// External objects loaded from the database for thin pack resolution.
/// When a REF_DELTA references an object not in the current pack, it's
/// looked up here. This handles incremental pushes where git deltifies
/// trees/blobs against objects from previous pushes.
/// External objects loaded from the database for thin pack resolution.
/// Stored as `Arc<[u8]>` so they can be passed into the cache without copying
/// when they become delta bases for pack entries.
pub type ExternalObjects = HashMap<String, (ObjectType, Arc<[u8]>)>;

/// Resolution context passed to `resolve_entry`.
///
/// Bundles the mutable cache and the read-only external objects map so
/// `resolve_entry` takes one context argument instead of growing its parameter
/// list every time a new concern is added.
pub struct ResolveCtx<'a> {
    pub cache: &'a mut ResolveCache,
    pub external: &'a ExternalObjects,
}

/// Resolve a single pack entry into its final (type, data).
///
/// Returns an `Arc<[u8]>` so the resolved bytes can be shared between the
/// cache and the caller without any additional copy.  A cache hit is a single
/// atomic pointer increment; the base object for a depth-50 delta chain is
/// allocated exactly once regardless of how many entries reference it.
pub fn resolve_entry(
    data: &[u8],
    index: &[PackEntryMeta],
    offset_to_idx: &HashMap<usize, usize>,
    entry_idx: usize,
    hash_to_idx: &HashMap<String, usize>,
    ctx: &mut ResolveCtx<'_>,
) -> Result<(ObjectType, Arc<[u8]>)> {
    // Cache hit: Arc::clone happened inside get() — no data copy.
    if let Some((obj_type, cached)) = ctx.cache.get(entry_idx) {
        return Ok((obj_type, cached));
    }

    let entry = &index[entry_idx];

    // Non-delta: decompress once, wrap in Arc, share between cache and caller.
    if let Some(obj_type) = ObjectType::from_type_num(entry.type_num) {
        let (decompressed, _) = zlib_decompress(data, entry.data_offset, entry.size)?;
        let arc: Arc<[u8]> = decompressed.into();
        ctx.cache.try_cache(entry_idx, obj_type, Arc::clone(&arc));
        return Ok((obj_type, arc));
    }

    // Delta: walk the chain back to a non-delta or cached base.
    let mut chain: Vec<usize> = Vec::new();
    let mut current = entry_idx;

    loop {
        if ctx.cache.contains(current) && current != entry_idx {
            break; // cached base found — stop walking
        }

        let e = &index[current];
        match e.type_num {
            1..=4 => break, // non-delta base
            6 => {
                chain.push(current);
                let base_offset = e
                    .base_pack_offset
                    .ok_or_else(|| ParseError("OFS_DELTA missing base_pack_offset".into()))?;
                current = *offset_to_idx.get(&base_offset).ok_or_else(|| {
                    ParseError(format!(
                        "OFS_DELTA base offset {} not found in index",
                        base_offset
                    ))
                })?;
            }
            7 => {
                chain.push(current);
                let base_hash = e
                    .base_hash
                    .as_ref()
                    .ok_or_else(|| ParseError("REF_DELTA missing base_hash".into()))?;
                if let Some(&idx) = hash_to_idx.get(base_hash.as_str()) {
                    current = idx;
                } else if ctx.external.contains_key(base_hash.as_str()) {
                    chain.pop();
                    break;
                } else {
                    return Err(ParseError(format!(
                        "REF_DELTA base {} not found",
                        base_hash
                    )));
                }
            }
            _ => {
                return Err(ParseError(format!(
                    "invalid type {} in delta chain",
                    e.type_num
                )));
            }
        }
    }

    // Resolve base — Arc from cache (pointer increment), external object
    // (already Arc), or fresh decompression wrapped in Arc.
    let (base_type, mut result): (ObjectType, Arc<[u8]>) = if let Some((t, d)) =
        ctx.cache.get(current)
    {
        (t, d) // Arc::clone already happened in get()
    } else if index[current].type_num == 7 {
        // REF_DELTA base is an external object from a previous push.
        let base_hash = index[current]
            .base_hash
            .as_ref()
            .ok_or_else(|| ParseError("REF_DELTA missing base_hash".into()))?;
        let (obj_type, base_data) = ctx
            .external
            .get(base_hash.as_str())
            .ok_or_else(|| ParseError(format!("external base {} not found", base_hash)))?;
        let (delta_data, _) =
            zlib_decompress(data, index[current].data_offset, index[current].size)?;
        let resolved = apply_git_delta(&**base_data, &delta_data)?;
        let arc: Arc<[u8]> = resolved.into();
        ctx.cache.try_cache(current, *obj_type, Arc::clone(&arc));
        (*obj_type, arc)
    } else {
        let t = ObjectType::from_type_num(index[current].type_num)
            .ok_or_else(|| ParseError(format!("invalid base type {}", index[current].type_num)))?;
        let (decompressed, _) =
            zlib_decompress(data, index[current].data_offset, index[current].size)?;
        let arc: Arc<[u8]> = decompressed.into();
        ctx.cache.try_cache(current, t, Arc::clone(&arc));
        (t, arc)
    };

    // Apply deltas innermost-first.  Each step: decompress delta payload,
    // apply instructions against the current base (deref Arc to &[u8]),
    // wrap result in a new Arc, cache it, advance.
    for &delta_idx in chain.iter().rev() {
        let (delta_data, _) =
            zlib_decompress(data, index[delta_idx].data_offset, index[delta_idx].size)?;
        let next = apply_git_delta(&*result, &delta_data)?;
        let arc: Arc<[u8]> = next.into();
        ctx.cache.try_cache(delta_idx, base_type, Arc::clone(&arc));
        result = arc;
    }

    Ok((base_type, result))
}

// ---------------------------------------------------------------------------
// Pack generation (for git fetch / clone)
// ---------------------------------------------------------------------------

/// Generate a valid pack file and write each chunk to `sink` as it becomes
/// available. This avoids creating a second full-size copy when callers want
/// to append the pack directly into a larger response body or sideband stream.
pub fn generate_into<F>(objects: &[PackObject], mut sink: F)
where
    F: FnMut(&[u8]),
{
    let mut hasher = sha1_smol::Sha1::new();

    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(b"PACK");
    header.extend_from_slice(&2u32.to_be_bytes()); // version 2
    header.extend_from_slice(&(objects.len() as u32).to_be_bytes());
    hasher.update(&header);
    sink(&header);

    for obj in objects {
        let mut object_header = Vec::with_capacity(16);
        write_type_and_size(
            &mut object_header,
            obj.obj_type.to_type_num(),
            obj.data.len(),
        );
        hasher.update(&object_header);
        sink(&object_header);

        let compressed = zlib_compress(&obj.data);
        hasher.update(&compressed);
        sink(&compressed);
    }

    let checksum = hasher.digest().bytes();
    sink(&checksum);
}

// ---------------------------------------------------------------------------
// Git object hashing
// ---------------------------------------------------------------------------

/// Compute the SHA-1 hash of a git object: sha1("{type} {size}\0{data}")
pub fn hash_object(obj_type: &ObjectType, data: &[u8]) -> String {
    let header = format!("{} {}\0", obj_type.as_str(), data.len());
    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(header.as_bytes());
    hasher.update(data);
    hasher.digest().to_string()
}

// ---------------------------------------------------------------------------
// Git delta format
// ---------------------------------------------------------------------------

/// Apply a git delta instruction stream to a base object.
///
/// Delta format:
///   <base_size: varint> <result_size: varint>
///   [instruction]*
///     bit 7 = 1: copy from base (next bytes encode offset + length)
///     bit 7 = 0: insert literal (bits 0-6 = length)
fn apply_git_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>> {
    let mut pos = 0;

    // Read base size (for validation)
    let (base_size, n) = read_varint_delta(delta, pos)?;
    pos += n;
    if base_size != base.len() {
        return Err(ParseError(format!(
            "delta base size mismatch: expected {}, got {}",
            base_size,
            base.len()
        )));
    }

    // Read result size
    let (result_size, n) = read_varint_delta(delta, pos)?;
    pos += n;

    let mut result = Vec::with_capacity(result_size);

    while pos < delta.len() {
        let cmd = delta[pos];
        pos += 1;

        if cmd & 0x80 != 0 {
            // Copy from base
            let mut offset: usize = 0;
            let mut length: usize = 0;

            if cmd & 0x01 != 0 {
                offset = delta.get(pos).copied().unwrap_or(0) as usize;
                pos += 1;
            }
            if cmd & 0x02 != 0 {
                offset |= (delta.get(pos).copied().unwrap_or(0) as usize) << 8;
                pos += 1;
            }
            if cmd & 0x04 != 0 {
                offset |= (delta.get(pos).copied().unwrap_or(0) as usize) << 16;
                pos += 1;
            }
            if cmd & 0x08 != 0 {
                offset |= (delta.get(pos).copied().unwrap_or(0) as usize) << 24;
                pos += 1;
            }

            if cmd & 0x10 != 0 {
                length = delta.get(pos).copied().unwrap_or(0) as usize;
                pos += 1;
            }
            if cmd & 0x20 != 0 {
                length |= (delta.get(pos).copied().unwrap_or(0) as usize) << 8;
                pos += 1;
            }
            if cmd & 0x40 != 0 {
                length |= (delta.get(pos).copied().unwrap_or(0) as usize) << 16;
                pos += 1;
            }

            if length == 0 {
                length = 0x10000; // special case per git docs
            }

            let end = offset + length;
            if end > base.len() {
                return Err(ParseError(format!(
                    "delta copy out of bounds: offset={}, length={}, base_len={}",
                    offset,
                    length,
                    base.len()
                )));
            }
            result.extend_from_slice(&base[offset..end]);
        } else if cmd != 0 {
            // Insert literal
            let length = cmd as usize;
            if pos + length > delta.len() {
                return Err(ParseError("delta insert truncated".into()));
            }
            result.extend_from_slice(&delta[pos..pos + length]);
            pos += length;
        } else {
            // cmd == 0 is reserved
            return Err(ParseError("delta: reserved instruction 0x00".into()));
        }
    }

    if result.len() != result_size {
        return Err(ParseError(format!(
            "delta result size mismatch: expected {}, got {}",
            result_size,
            result.len()
        )));
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Internal: binary helpers
// ---------------------------------------------------------------------------

fn read_u32_be(data: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

/// Read the type (3 bits) and size (variable-length) from a pack object header.
/// Returns (type_num, size, bytes_consumed).
fn read_type_and_size(data: &[u8], pos: usize) -> Result<(u8, usize, usize)> {
    if pos >= data.len() {
        return Err(ParseError(
            "unexpected end of pack reading type/size".into(),
        ));
    }
    let byte = data[pos];
    let type_num = (byte >> 4) & 0x07;
    let mut size = (byte & 0x0F) as usize;
    let mut shift = 4;
    let mut offset = 1;

    if byte & 0x80 != 0 {
        loop {
            if pos + offset >= data.len() {
                return Err(ParseError("truncated size encoding".into()));
            }
            let b = data[pos + offset];
            size |= ((b & 0x7F) as usize) << shift;
            shift += 7;
            offset += 1;
            if b & 0x80 == 0 {
                break;
            }
        }
    }

    Ok((type_num, size, offset))
}

/// Read the OFS_DELTA negative offset encoding.
/// Returns (offset, bytes_consumed).
fn read_ofs_delta_offset(data: &[u8], pos: usize) -> Result<(usize, usize)> {
    if pos >= data.len() {
        return Err(ParseError("truncated OFS_DELTA offset".into()));
    }
    let mut byte = data[pos];
    let mut offset = (byte & 0x7F) as usize;
    let mut consumed = 1;

    while byte & 0x80 != 0 {
        if pos + consumed >= data.len() {
            return Err(ParseError("truncated OFS_DELTA offset".into()));
        }
        offset += 1;
        byte = data[pos + consumed];
        offset = (offset << 7) | (byte & 0x7F) as usize;
        consumed += 1;
    }

    Ok((offset, consumed))
}

/// Read a varint from git's delta header (different encoding from pack header).
fn read_varint_delta(data: &[u8], pos: usize) -> Result<(usize, usize)> {
    let mut value: usize = 0;
    let mut shift = 0;
    let mut i = pos;

    loop {
        if i >= data.len() {
            return Err(ParseError("truncated delta varint".into()));
        }
        let byte = data[i];
        value |= ((byte & 0x7F) as usize) << shift;
        shift += 7;
        i += 1;
        if byte & 0x80 == 0 {
            break;
        }
    }

    Ok((value, i - pos))
}

/// Zlib decompress starting at `pos` in `data`, discarding the output.
/// Returns the number of compressed bytes consumed from the input.
/// Used during index building to skip over zlib data without allocating.
fn zlib_skip(data: &[u8], pos: usize) -> Result<usize> {
    let mut decoder = ZlibDecoder::new(&data[pos..]);
    std::io::copy(&mut decoder, &mut std::io::sink())
        .map_err(|e| ParseError(format!("zlib decompression failed: {}", e)))?;
    Ok(decoder.total_in() as usize)
}

/// Maximum preallocation for zlib decompression output. The `size_hint`
/// comes from the pack header which is client-controlled — a malicious push
/// could claim a 4 GB decompressed size for a tiny entry. Capping prevents
/// input-driven OOM. If the real data exceeds this, Vec grows naturally.
const MAX_PREALLOC: usize = 100_000_000; // 100 MB

/// Zlib decompress starting at `pos` in `data`.
/// `size_hint` pre-allocates the output buffer to avoid costly Vec reallocs.
/// Without this, decompressing an 87 MB blob would double the buffer
/// repeatedly (64→128 MB), needing 192 MB peak during the copy.
/// Returns (decompressed_bytes, bytes_consumed_from_input).
fn zlib_decompress(data: &[u8], pos: usize, size_hint: usize) -> Result<(Vec<u8>, usize)> {
    let mut decoder = ZlibDecoder::new(&data[pos..]);
    let mut output = Vec::with_capacity(size_hint.min(MAX_PREALLOC));
    decoder
        .read_to_end(&mut output)
        .map_err(|e| ParseError(format!("zlib decompression failed: {}", e)))?;
    let consumed = decoder.total_in() as usize;
    Ok((output, consumed))
}

/// Zlib compress data.
fn zlib_compress(data: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("zlib compress write");
    encoder.finish().expect("zlib compress finish")
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Write a pack object type+size header.
fn write_type_and_size(buf: &mut Vec<u8>, type_num: u8, size: usize) {
    let mut byte = (type_num << 4) | (size as u8 & 0x0F);
    let mut remaining = size >> 4;

    if remaining > 0 {
        byte |= 0x80;
        buf.push(byte);
        while remaining > 0 {
            let mut b = (remaining & 0x7F) as u8;
            remaining >>= 7;
            if remaining > 0 {
                b |= 0x80;
            }
            buf.push(b);
        }
    } else {
        buf.push(byte);
    }
}
