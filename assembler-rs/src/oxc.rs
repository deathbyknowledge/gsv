use std::collections::BTreeSet;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_resolver::{
    FileMetadata, FileSystem, ModuleType, PackageType, ResolveError, ResolveOptions,
    ResolverGeneric,
};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_syntax::module_record::ModuleRecord;
use oxc_transformer::{TransformOptions, Transformer};

use crate::diagnostics::PackageAssemblyDiagnostic;
use crate::virtual_fs::{dirname, extension, normalize_repo_path, VirtualFileTree};

#[derive(Clone, Debug)]
pub struct OxcVirtualFileSystem {
    root: PathBuf,
    files: Arc<VirtualFileTree>,
    directories: Arc<BTreeSet<String>>,
}

#[derive(Debug)]
pub struct OxcResolver {
    file_system: OxcVirtualFileSystem,
    resolver: ResolverGeneric<OxcVirtualFileSystem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolverMode {
    Generic,
    Browser,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedModule {
    pub repo_path: String,
    pub module_type: Option<ModuleType>,
    pub package_json_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedModuleDependencies {
    pub requested_modules: Vec<String>,
    pub has_module_syntax: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleRequestSpan {
    pub specifier: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransformedModuleSource {
    pub content: String,
    pub requested_modules: Vec<String>,
    pub has_module_syntax: bool,
}

impl OxcVirtualFileSystem {
    pub fn from_virtual_tree(files: VirtualFileTree) -> Self {
        let directories = collect_directories(&files);
        Self {
            root: PathBuf::from("/virtual"),
            files: Arc::new(files),
            directories: Arc::new(directories),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn to_absolute_path(&self, repo_path: &str) -> PathBuf {
        self.root.join(normalize_repo_path(repo_path))
    }

    pub fn to_repo_path(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        let joined = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => value.to_str().map(|value| value.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        (!joined.is_empty()).then_some(joined)
    }

    fn read_file_bytes(&self, path: &Path) -> io::Result<Vec<u8>> {
        let repo_path = self
            .to_repo_path(path)
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        self.files
            .get(&repo_path)
            .map(|content| content.as_bytes().to_vec())
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }

    fn is_file(&self, path: &Path) -> bool {
        self.to_repo_path(path)
            .as_deref()
            .map(|repo_path| self.files.contains(repo_path))
            .unwrap_or(false)
    }

    fn is_dir(&self, path: &Path) -> bool {
        if path == self.root {
            return true;
        }
        self.to_repo_path(path)
            .as_deref()
            .map(|repo_path| self.directories.contains(repo_path))
            .unwrap_or(false)
    }
}

impl Default for OxcResolver {
    fn default() -> Self {
        Self::new(VirtualFileTree::default())
    }
}

impl OxcResolver {
    pub fn new(files: VirtualFileTree) -> Self {
        Self::new_with_mode(files, ResolverMode::Generic)
    }

    pub fn new_browser(files: VirtualFileTree) -> Self {
        Self::new_with_mode(files, ResolverMode::Browser)
    }

    fn new_with_mode(files: VirtualFileTree, mode: ResolverMode) -> Self {
        let file_system = OxcVirtualFileSystem::from_virtual_tree(files);
        let resolver = ResolverGeneric::new_with_file_system(
            file_system.clone(),
            ResolveOptions {
                alias_fields: vec![vec!["browser".into()]],
                condition_names: match mode {
                    ResolverMode::Generic => {
                        vec!["browser".into(), "import".into(), "require".into(), "default".into()]
                    }
                    ResolverMode::Browser => {
                        vec!["browser".into(), "import".into(), "default".into()]
                    }
                },
                extensions: vec![
                    ".js".into(),
                    ".jsx".into(),
                    ".ts".into(),
                    ".tsx".into(),
                    ".mjs".into(),
                    ".mts".into(),
                    ".cjs".into(),
                    ".cts".into(),
                    ".json".into(),
                ],
                extension_alias: vec![
                    (
                        ".js".into(),
                        vec![".ts".into(), ".tsx".into(), ".js".into(), ".jsx".into()],
                    ),
                    (".mjs".into(), vec![".mts".into(), ".mjs".into()]),
                    (".cjs".into(), vec![".cts".into(), ".cjs".into()]),
                ],
                main_fields: vec!["browser".into(), "module".into(), "main".into()],
                module_type: true,
                ..ResolveOptions::default()
            },
        );
        Self {
            file_system,
            resolver,
        }
    }

    pub fn file_system(&self) -> &OxcVirtualFileSystem {
        &self.file_system
    }

    pub fn resolve_specifier(
        &self,
        importer_repo_path: &str,
        specifier: &str,
    ) -> Result<ResolvedModule, PackageAssemblyDiagnostic> {
        let importer_abs = self.file_system.to_absolute_path(importer_repo_path);
        let importer_dir = importer_abs
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.file_system.root().to_path_buf());
        let resolution = self
            .resolver
            .resolve(&importer_dir, specifier)
            .map_err(|error| {
                PackageAssemblyDiagnostic::error(
                    "resolve.not-found",
                    format!(
                        "Could not resolve specifier {specifier} from {importer_repo_path}: {error}"
                    ),
                    importer_repo_path,
                )
            })?;
        let repo_path = self
            .file_system
            .to_repo_path(&resolution.full_path())
            .ok_or_else(|| {
                PackageAssemblyDiagnostic::error(
                    "resolve.not-found",
                    format!(
                        "Resolved specifier {specifier} from {importer_repo_path} to a path outside the virtual filesystem."
                    ),
                    importer_repo_path,
                )
            })?;
        let package_json_path = resolution
            .package_json()
            .and_then(|package_json| self.file_system.to_repo_path(&package_json.path));
        let package_type = resolution
            .package_json()
            .and_then(|package_json| package_json.r#type());
        let inferred_module_type = infer_module_type_from_path(&resolution.full_path(), package_type);
        Ok(ResolvedModule {
            repo_path,
            module_type: match (resolution.module_type(), inferred_module_type) {
                (Some(ModuleType::CommonJs), Some(ModuleType::Module))
                    if prefers_esm_module_type(&resolution.full_path()) =>
                {
                    Some(ModuleType::Module)
                }
                (Some(module_type), _) => Some(module_type),
                (None, inferred) => inferred,
            },
            package_json_path,
        })
    }
}

impl FileSystem for OxcVirtualFileSystem {
    fn new() -> Self {
        Self::from_virtual_tree(VirtualFileTree::default())
    }

    fn read(&self, path: &Path) -> Result<Vec<u8>, io::Error> {
        self.read_file_bytes(path)
    }

    fn read_to_string(&self, path: &Path) -> Result<String, io::Error> {
        String::from_utf8(self.read_file_bytes(path)?)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
    }

    fn metadata(&self, path: &Path) -> Result<FileMetadata, io::Error> {
        metadata_for_path(self.is_file(path), self.is_dir(path))
    }

    fn symlink_metadata(&self, path: &Path) -> Result<FileMetadata, io::Error> {
        metadata_for_path(self.is_file(path), self.is_dir(path))
    }

    fn read_link(&self, _path: &Path) -> Result<PathBuf, ResolveError> {
        Err(io::Error::from(io::ErrorKind::NotFound).into())
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, io::Error> {
        if self.is_file(path) || self.is_dir(path) {
            Ok(path.to_path_buf())
        } else {
            Err(io::Error::from(io::ErrorKind::NotFound))
        }
    }
}

pub fn parse_source_text_with_oxc(
    path: &str,
    source_text: &str,
) -> Result<(), PackageAssemblyDiagnostic> {
    parse_module_dependencies_with_oxc(path, source_text).map(|_| ())
}

pub fn collect_module_request_spans_with_oxc(
    path: &str,
    source_text: &str,
) -> Result<Vec<ModuleRequestSpan>, PackageAssemblyDiagnostic> {
    let source_type = source_type_from_path(path)?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    if parsed.panicked {
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser panicked while parsing {path}."),
            path,
        ));
    }
    if !parsed.errors.is_empty() {
        let message = parsed
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser reported syntax errors: {message}"),
            path,
        ));
    }

    let mut spans = parsed
        .module_record
        .requested_modules
        .iter()
        .flat_map(|(specifier, occurrences)| {
            occurrences.iter().map(|occurrence| ModuleRequestSpan {
                specifier: specifier.to_string(),
                start: occurrence.span.start as usize,
                end: occurrence.span.end as usize,
            })
        })
        .collect::<Vec<_>>();
    spans.extend(collect_import_meta_url_request_spans(source_text));
    spans.sort_by_key(|span| (span.start, span.end));
    spans.dedup_by(|left, right| {
        left.start == right.start && left.end == right.end && left.specifier == right.specifier
    });
    Ok(spans)
}

pub fn transform_source_text_with_oxc(
    path: &str,
    source_text: &str,
) -> Result<String, PackageAssemblyDiagnostic> {
    transform_module_source_with_oxc(path, source_text).map(|transformed| transformed.content)
}

pub fn parse_module_dependencies_with_oxc(
    path: &str,
    source_text: &str,
) -> Result<ParsedModuleDependencies, PackageAssemblyDiagnostic> {
    let source_type = source_type_from_path(path)?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    if parsed.panicked {
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser panicked while parsing {path}."),
            path,
        ));
    }
    if !parsed.errors.is_empty() {
        let message = parsed
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser reported syntax errors: {message}"),
            path,
        ));
    }
    Ok(ParsedModuleDependencies {
        requested_modules: collect_requested_modules(&parsed.module_record, source_text),
        has_module_syntax: parsed.module_record.has_module_syntax,
    })
}

pub fn transform_module_source_with_oxc(
    path: &str,
    source_text: &str,
) -> Result<TransformedModuleSource, PackageAssemblyDiagnostic> {
    let source_type = source_type_from_path(path)?;
    let normalized = normalize_repo_path(path);
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source_text, source_type).parse();
    if parsed.panicked {
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser panicked while parsing {path}."),
            path,
        ));
    }
    if !parsed.errors.is_empty() {
        let message = parsed
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(PackageAssemblyDiagnostic::error(
            "transform.parse-error",
            format!("Oxc parser reported syntax errors: {message}"),
            path,
        ));
    }

    let mut program = parsed.program;

    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_excess_capacity(2.0)
        .build(&program);
    if !semantic.errors.is_empty() {
        let message = semantic
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(PackageAssemblyDiagnostic::error(
            "transform.semantic-error",
            format!("Oxc semantic analysis reported errors: {message}"),
            path,
        ));
    }

    let scoping = semantic.semantic.into_scoping();
    let transform_options = transform_options_for_path(path);
    let transformed = Transformer::new(&allocator, Path::new(&normalized), &transform_options)
        .build_with_scoping(scoping, &mut program);
    if !transformed.errors.is_empty() {
        let message = transformed
            .errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(PackageAssemblyDiagnostic::error(
            "transform.emit-error",
            format!("Oxc transformer reported errors: {message}"),
            path,
        ));
    }

    let content = Codegen::new()
        .with_scoping(Some(transformed.scoping))
        .build(&program)
        .code;
    let transformed_dependencies = parse_module_dependencies_with_oxc(path, &content)?;

    Ok(TransformedModuleSource {
        content,
        requested_modules: transformed_dependencies.requested_modules,
        has_module_syntax: transformed_dependencies.has_module_syntax,
    })
}

fn source_type_from_path(path: &str) -> Result<SourceType, PackageAssemblyDiagnostic> {
    let normalized = normalize_repo_path(path);
    SourceType::from_path(&normalized).map_err(|_| {
        let extension = extension(&normalized).unwrap_or_else(|| "unknown".to_string());
        PackageAssemblyDiagnostic::error(
            "transform.unsupported-syntax",
            format!("Could not infer Oxc source type for .{extension} file."),
            normalized,
        )
    })
}

fn transform_options_for_path(_path: &str) -> TransformOptions {
    let mut options = TransformOptions::default();
    options.jsx.import_source = Some("preact".to_string());
    options
}

fn collect_directories(files: &VirtualFileTree) -> BTreeSet<String> {
    let mut directories = BTreeSet::new();
    for (path, _) in files.iter() {
        let mut current = dirname(path);
        while !current.is_empty() {
            directories.insert(current.clone());
            current = dirname(&current);
        }
    }
    directories
}

fn collect_requested_modules(module_record: &ModuleRecord<'_>, source_text: &str) -> Vec<String> {
    let mut requested = module_record
        .requested_modules
        .keys()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    requested.extend(
        collect_import_meta_url_request_spans(source_text)
            .into_iter()
            .map(|span| span.specifier),
    );
    requested.sort();
    requested.dedup();
    requested
}

fn collect_import_meta_url_request_spans(source: &str) -> Vec<ModuleRequestSpan> {
    let mut spans = Vec::new();
    let mut search_from = 0usize;
    const PATTERN: &str = "new URL(";
    const IMPORT_META_URL: &str = "import.meta.url";

    while let Some(relative_match) = source[search_from..].find(PATTERN) {
        let pattern_start = search_from + relative_match;
        let mut index = pattern_start + PATTERN.len();
        index = skip_ascii_whitespace(source, index);
        let Some(quote) = source[index..].chars().next() else {
            break;
        };
        if quote != '"' && quote != '\'' {
            search_from = index.saturating_add(1);
            continue;
        }

        let literal_start = index;
        index += quote.len_utf8();
        let Some(literal_end) = find_quoted_literal_end(source, index, quote) else {
            search_from = index;
            continue;
        };
        let specifier = source[index..literal_end].to_string();

        let mut suffix_index = skip_ascii_whitespace(source, literal_end + quote.len_utf8());
        if !source[suffix_index..].starts_with(',') {
            search_from = literal_end + quote.len_utf8();
            continue;
        }
        suffix_index += 1;
        suffix_index = skip_ascii_whitespace(source, suffix_index);
        if !source[suffix_index..].starts_with(IMPORT_META_URL) {
            search_from = literal_end + quote.len_utf8();
            continue;
        }
        suffix_index += IMPORT_META_URL.len();
        suffix_index = skip_ascii_whitespace(source, suffix_index);
        if !source[suffix_index..].starts_with(')') {
            search_from = literal_end + quote.len_utf8();
            continue;
        }

        spans.push(ModuleRequestSpan {
            specifier,
            start: literal_start,
            end: literal_end + quote.len_utf8(),
        });
        search_from = suffix_index + 1;
    }

    spans
}

fn skip_ascii_whitespace(source: &str, mut index: usize) -> usize {
    while let Some(ch) = source[index..].chars().next() {
        if !ch.is_ascii_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn find_quoted_literal_end(source: &str, mut index: usize, quote: char) -> Option<usize> {
    let mut escaped = false;
    while let Some(ch) = source[index..].chars().next() {
        if escaped {
            escaped = false;
            index += ch.len_utf8();
            continue;
        }
        if ch == '\\' {
            escaped = true;
            index += ch.len_utf8();
            continue;
        }
        if ch == quote {
            return Some(index);
        }
        index += ch.len_utf8();
    }
    None
}

fn infer_module_type_from_path(
    path: &Path,
    package_type: Option<PackageType>,
) -> Option<ModuleType> {
    if prefers_esm_module_type(path) {
        return Some(ModuleType::Module);
    }

    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "mjs" | "mts" | "ts" | "tsx" => Some(ModuleType::Module),
        "cjs" | "cts" => Some(ModuleType::CommonJs),
        "json" => Some(ModuleType::Json),
        "js" | "jsx" => match package_type {
            Some(PackageType::Module) => Some(ModuleType::Module),
            Some(PackageType::CommonJs) | None => Some(ModuleType::CommonJs),
        },
        _ => None,
    }
}

fn prefers_esm_module_type(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".module.js") || lower.ends_with(".module.jsx") || lower.ends_with(".esm.js")
}

fn metadata_for_path(is_file: bool, is_dir: bool) -> Result<FileMetadata, io::Error> {
    if !is_file && !is_dir {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    Ok(FileMetadata::new(is_file, is_dir, false))
}
