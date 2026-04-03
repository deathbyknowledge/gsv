use std::collections::{BTreeMap, HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    CallExpression, ExportDefaultDeclarationKind, Expression, ImportDeclarationSpecifier,
    ObjectProperty, ObjectPropertyKind, Statement,
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use serde::{Deserialize, Serialize};
use worker::{Error, Result, SqlStorage, SqlStorageValue};

use super::{
    normalize_subdir, resolve_source, PackageDiagnostic, PackageDiagnosticSeverity,
    PackageSourceLocator, ResolvedPackageSource,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExtractedHandlerReferenceKind {
    #[serde(rename = "inline-function")]
    InlineFunction,
    #[serde(rename = "local-identifier")]
    LocalIdentifier,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedHandlerReference {
    pub kind: ExtractedHandlerReferenceKind,
    pub export_name: String,
    pub path: String,
    pub local_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedPackageWindowMeta {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub min_width: Option<u32>,
    pub min_height: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedPackageCapabilityMeta {
    pub kernel: Vec<String>,
    pub outbound: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedPackageMeta {
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub window: Option<ExtractedPackageWindowMeta>,
    pub capabilities: ExtractedPackageCapabilityMeta,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedCommandDefinition {
    pub name: String,
    pub handler: ExtractedHandlerReference,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedTaskDefinition {
    pub name: String,
    pub handler: ExtractedHandlerReference,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedAppDefinition {
    pub handler: ExtractedHandlerReference,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedPackageDefinition {
    pub meta: ExtractedPackageMeta,
    pub setup: Option<ExtractedHandlerReference>,
    pub commands: Vec<ExtractedCommandDefinition>,
    pub app: Option<ExtractedAppDefinition>,
    pub tasks: Vec<ExtractedTaskDefinition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzedPackageJson {
    pub name: String,
    pub version: Option<String>,
    #[serde(rename = "type")]
    pub package_type: Option<String>,
    pub dependencies: BTreeMap<String, String>,
    pub dev_dependencies: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageIdentity {
    pub package_json_name: String,
    pub version: Option<String>,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageAnalysis {
    pub source: ResolvedPackageSource,
    pub package_root: String,
    pub identity: PackageIdentity,
    pub package_json: AnalyzedPackageJson,
    pub definition: Option<ExtractedPackageDefinition>,
    pub diagnostics: Vec<PackageDiagnostic>,
    pub ok: bool,
    pub analysis_hash: String,
}

#[derive(Deserialize)]
struct RawPackageJson {
    name: String,
    version: Option<String>,
    #[serde(rename = "type")]
    package_type: Option<String>,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "devDependencies")]
    dev_dependencies: BTreeMap<String, String>,
}

pub(crate) fn analyze_package(
    sql: &SqlStorage,
    locator: &PackageSourceLocator,
) -> Result<PackageAnalysis> {
    let source = resolve_source(sql, locator)?;
    let package_json_path = format!("{}/package.json", source.subdir);
    let package_module_path = format!("{}/src/package.ts", source.subdir);

    let package_json_text = read_utf8_file_at_commit(sql, &source.resolved_commit, &package_json_path)?
        .ok_or_else(|| Error::RustError(format!("missing package file: {}", package_json_path)))?;
    let package_module_text = read_utf8_file_at_commit(sql, &source.resolved_commit, &package_module_path)?
        .ok_or_else(|| Error::RustError(format!("missing package file: {}", package_module_path)))?;

    analyze_package_source(source, package_json_text, package_module_text)
}

pub(crate) fn analyze_package_source(
    source: ResolvedPackageSource,
    package_json_text: String,
    package_module_text: String,
) -> Result<PackageAnalysis> {
    let package_root = normalize_subdir(&source.subdir)?;
    let raw_package_json: RawPackageJson = serde_json::from_str(&package_json_text)
        .map_err(|err| Error::RustError(format!("invalid package.json: {}", err)))?;

    let package_json = AnalyzedPackageJson {
        name: raw_package_json.name.clone(),
        version: raw_package_json.version.clone(),
        package_type: raw_package_json.package_type.clone(),
        dependencies: raw_package_json.dependencies,
        dev_dependencies: raw_package_json.dev_dependencies,
    };

    let (definition, diagnostics) = extract_definition(&package_module_text);
    let ok = diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != PackageDiagnosticSeverity::Error)
        && definition.is_some();

    let identity = PackageIdentity {
        package_json_name: package_json.name.clone(),
        version: package_json.version.clone(),
        display_name: definition
            .as_ref()
            .map(|value| value.meta.display_name.clone())
            .unwrap_or_else(|| package_json.name.clone()),
    };

    let mut hasher = sha1_smol::Sha1::new();
    hasher.update(source.resolved_commit.as_bytes());
    hasher.update(package_root.as_bytes());
    hasher.update(package_json_text.as_bytes());
    hasher.update(package_module_text.as_bytes());
    let analysis_hash = hasher.digest().to_string();

    Ok(PackageAnalysis {
        source,
        package_root,
        identity,
        package_json,
        definition,
        diagnostics,
        ok,
        analysis_hash,
    })
}

fn read_utf8_file_at_commit(sql: &SqlStorage, commit_hash: &str, path: &str) -> Result<Option<String>> {
    let blob_hash = resolve_blob_hash_at_commit(sql, commit_hash, path)?;
    let Some(blob_hash) = blob_hash else {
        return Ok(None);
    };
    let Some(bytes) = crate::store::reconstruct_blob_by_hash(sql, &blob_hash)? else {
        return Ok(None);
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| Error::RustError(format!("file is not valid utf-8: {}", path)))?;
    Ok(Some(text))
}

fn resolve_blob_hash_at_commit(sql: &SqlStorage, commit_hash: &str, path: &str) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct CommitRow {
        tree_hash: String,
    }

    #[derive(Deserialize)]
    struct TreeRow {
        mode: i64,
        entry_hash: String,
    }

    let commits: Vec<CommitRow> = sql
        .exec(
            "SELECT tree_hash FROM commits WHERE hash = ?",
            vec![SqlStorageValue::from(commit_hash.to_string())],
        )?
        .to_array()?;

    let Some(commit) = commits.into_iter().next() else {
        return Ok(None);
    };

    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.is_empty() {
        return Ok(None);
    }

    let mut current_tree = commit.tree_hash;

    for (index, segment) in segments.iter().enumerate() {
        let rows: Vec<TreeRow> = sql
            .exec(
                "SELECT mode, entry_hash FROM trees WHERE tree_hash = ? AND name = ?",
                vec![
                    SqlStorageValue::from(current_tree.clone()),
                    SqlStorageValue::from((*segment).to_string()),
                ],
            )?
            .to_array()?;

        let Some(entry) = rows.into_iter().next() else {
            return Ok(None);
        };

        let is_last = index == segments.len() - 1;
        if is_last {
            if entry.mode == 0o040000 {
                return Ok(None);
            }
            return Ok(Some(entry.entry_hash));
        }

        if entry.mode != 0o040000 {
            return Ok(None);
        }
        current_tree = entry.entry_hash;
    }

    Ok(None)
}

fn extract_definition(source_text: &str) -> (Option<ExtractedPackageDefinition>, Vec<PackageDiagnostic>) {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path("src/package.ts").unwrap_or(SourceType::ts());
    let parser_return = Parser::new(&allocator, source_text, source_type).parse();

    let mut diagnostics = Vec::new();
    for error in parser_return.errors {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "parser-error",
            error.to_string(),
            "src/package.ts",
            None,
            source_text,
        ));
    }

    if !diagnostics.is_empty() {
        return (None, diagnostics);
    }

    let program = parser_return.program;
    let mut local_package_calls: HashMap<String, &CallExpression<'_>> = HashMap::new();
    let mut local_identifiers: HashSet<String> = HashSet::new();
    let mut has_define_package_import = false;
    let mut export_default_call: Option<&CallExpression<'_>> = None;

    for statement in program.body.iter() {
        match statement {
            Statement::ImportDeclaration(import_decl) => {
                if import_decl.source.value.as_str() != "@gsv/package-worker" {
                    continue;
                }
                if let Some(specifiers) = import_decl.specifiers.as_ref() {
                    for specifier in specifiers.iter() {
                        if let ImportDeclarationSpecifier::ImportSpecifier(spec) = specifier {
                            if spec.imported.name() == "definePackage" && spec.local.name.as_str() == "definePackage" {
                                has_define_package_import = true;
                            }
                        }
                    }
                }
            }
            Statement::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    local_identifiers.insert(id.name.to_string());
                }
            }
            Statement::VariableDeclaration(variable_decl) => {
                for declarator in variable_decl.declarations.iter() {
                    let Some(binding) = declarator.id.get_binding_identifier() else {
                        continue;
                    };
                    let local_name = binding.name.to_string();
                    local_identifiers.insert(local_name.clone());
                    if let Some(init) = declarator.init.as_ref() {
                        if let Expression::CallExpression(call_expr) = init {
                            if is_define_package_call(call_expr) {
                                local_package_calls.insert(local_name, call_expr);
                            }
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export_decl) => match &export_decl.declaration {
                ExportDefaultDeclarationKind::CallExpression(call_expr) => {
                    export_default_call = Some(call_expr);
                }
                ExportDefaultDeclarationKind::Identifier(identifier) => {
                    if let Some(call_expr) = local_package_calls.get(identifier.name.as_str()) {
                        export_default_call = Some(*call_expr);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    if !has_define_package_import {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "missing-define-package-import",
            "src/package.ts must import definePackage directly from @gsv/package-worker".to_string(),
            "src/package.ts",
            None,
            source_text,
        ));
        return (None, diagnostics);
    }

    let Some(package_call) = export_default_call else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "missing-define-package-export",
            "default export must be definePackage(...) or a same-module const initialized from definePackage(...)".to_string(),
            "src/package.ts",
            None,
            source_text,
        ));
        return (None, diagnostics);
    };

    if !is_define_package_call(package_call) {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "invalid-define-package-call",
            "default export does not resolve to definePackage(...)".to_string(),
            "src/package.ts",
            Some(package_call.span),
            source_text,
        ));
        return (None, diagnostics);
    }

    let Some(first_arg) = package_call.arguments.first() else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "missing-package-definition",
            "definePackage(...) requires an object literal argument".to_string(),
            "src/package.ts",
            Some(package_call.span),
            source_text,
        ));
        return (None, diagnostics);
    };

    let Some(arg_expr) = first_arg.as_expression() else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-package-definition",
            "definePackage(...) argument must be an object literal expression".to_string(),
            "src/package.ts",
            Some(first_arg.span()),
            source_text,
        ));
        return (None, diagnostics);
    };

    let Some(package_object) = get_object_expr(arg_expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-package-definition",
            "definePackage(...) argument must be an object literal".to_string(),
            "src/package.ts",
            Some(arg_expr.span()),
            source_text,
        ));
        return (None, diagnostics);
    };

    let definition = extract_package_object(package_object, source_text, &local_identifiers, &mut diagnostics);
    if diagnostics.iter().any(|diagnostic| diagnostic.severity == PackageDiagnosticSeverity::Error) {
        (None, diagnostics)
    } else {
        (definition, diagnostics)
    }
}

fn extract_package_object(
    object: &oxc_ast::ast::ObjectExpression<'_>,
    source_text: &str,
    local_identifiers: &HashSet<String>,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedPackageDefinition> {
    let mut meta_expr: Option<&Expression<'_>> = None;
    let mut setup = None;
    let mut commands = Vec::new();
    let mut app = None;
    let mut tasks = Vec::new();

    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unsupported-spread-property",
                "spread properties are not supported in definePackage(...)".to_string(),
                "src/package.ts",
                Some(property.span()),
                source_text,
            ));
            continue;
        };

        if prop.computed {
            diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "computed-property",
                "computed properties are not supported in definePackage(...)".to_string(),
                "src/package.ts",
                Some(prop.span),
                source_text,
            ));
            continue;
        }

        let Some(key) = static_property_name(prop, source_text) else {
            diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unsupported-property-key",
                "property key must be a static identifier or string literal".to_string(),
                "src/package.ts",
                Some(prop.span),
                source_text,
            ));
            continue;
        };

        match key.as_str() {
            "meta" => meta_expr = Some(&prop.value),
            "setup" => {
                setup = extract_handler_reference(&prop.value, local_identifiers, source_text, diagnostics)
            }
            "commands" => {
                commands = extract_named_handlers(&prop.value, local_identifiers, source_text, diagnostics, "command")
            }
            "app" => {
                app = extract_app_definition(&prop.value, local_identifiers, source_text, diagnostics)
            }
            "tasks" => {
                tasks = extract_named_handlers(&prop.value, local_identifiers, source_text, diagnostics, "task")
                    .into_iter()
                    .map(|entry| ExtractedTaskDefinition { name: entry.name, handler: entry.handler })
                    .collect();
            }
            other => diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unknown-top-level-key",
                format!("unsupported top-level package property: {}", other),
                "src/package.ts",
                Some(prop.span),
                source_text,
            )),
        }
    }

    let Some(meta_expr) = meta_expr else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "missing-meta",
            "definePackage(...) requires a meta object".to_string(),
            "src/package.ts",
            Some(object.span),
            source_text,
        ));
        return None;
    };

    let Some(meta) = extract_meta(meta_expr, source_text, diagnostics) else {
        return None;
    };

    Some(ExtractedPackageDefinition {
        meta,
        setup,
        commands,
        app,
        tasks,
    })
}

fn extract_meta(
    expr: &Expression<'_>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedPackageMeta> {
    let Some(object) = get_object_expr(expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-meta",
            "meta must be an object literal".to_string(),
            "src/package.ts",
            Some(expr.span()),
            source_text,
        ));
        return None;
    };

    let mut display_name = None;
    let mut description = None;
    let mut icon = None;
    let mut window = None;
    let mut capabilities = ExtractedPackageCapabilityMeta {
        kernel: Vec::new(),
        outbound: Vec::new(),
    };

    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            continue;
        };
        if prop.computed {
            continue;
        }
        let Some(key) = static_property_name(prop, source_text) else {
            continue;
        };

        match key.as_str() {
            "displayName" => display_name = extract_string_literal(&prop.value),
            "description" => description = extract_string_literal(&prop.value),
            "icon" => icon = extract_string_literal(&prop.value),
            "window" => window = extract_window_meta(&prop.value, source_text, diagnostics),
            "capabilities" => {
                if let Some(value) = extract_capabilities(&prop.value, source_text, diagnostics) {
                    capabilities = value;
                }
            }
            other => diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unknown-meta-key",
                format!("unsupported meta property: {}", other),
                "src/package.ts",
                Some(prop.span),
                source_text,
            )),
        }
    }

    let Some(display_name) = display_name else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "missing-display-name",
            "meta.displayName is required and must be a string literal".to_string(),
            "src/package.ts",
            Some(object.span),
            source_text,
        ));
        return None;
    };

    Some(ExtractedPackageMeta {
        display_name,
        description,
        icon,
        window,
        capabilities,
    })
}

fn extract_window_meta(
    expr: &Expression<'_>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedPackageWindowMeta> {
    let Some(object) = get_object_expr(expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-window",
            "meta.window must be an object literal".to_string(),
            "src/package.ts",
            Some(expr.span()),
            source_text,
        ));
        return None;
    };

    let mut width = None;
    let mut height = None;
    let mut min_width = None;
    let mut min_height = None;

    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            continue;
        };
        if prop.computed {
            continue;
        }
        let Some(key) = static_property_name(prop, source_text) else {
            continue;
        };
        let value = extract_u32_literal(&prop.value);
        match key.as_str() {
            "width" => width = value,
            "height" => height = value,
            "minWidth" => min_width = value,
            "minHeight" => min_height = value,
            other => diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unknown-window-key",
                format!("unsupported window property: {}", other),
                "src/package.ts",
                Some(prop.span),
                source_text,
            )),
        }
    }

    Some(ExtractedPackageWindowMeta {
        width,
        height,
        min_width,
        min_height,
    })
}

fn extract_capabilities(
    expr: &Expression<'_>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedPackageCapabilityMeta> {
    let Some(object) = get_object_expr(expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-capabilities",
            "meta.capabilities must be an object literal".to_string(),
            "src/package.ts",
            Some(expr.span()),
            source_text,
        ));
        return None;
    };

    let mut kernel = Vec::new();
    let mut outbound = Vec::new();

    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            continue;
        };
        if prop.computed {
            continue;
        }
        let Some(key) = static_property_name(prop, source_text) else {
            continue;
        };
        let values = extract_string_array(&prop.value);
        match key.as_str() {
            "kernel" => kernel = values.unwrap_or_default(),
            "outbound" => outbound = values.unwrap_or_default(),
            other => diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unknown-capability-key",
                format!("unsupported capabilities property: {}", other),
                "src/package.ts",
                Some(prop.span),
                source_text,
            )),
        }
    }

    Some(ExtractedPackageCapabilityMeta { kernel, outbound })
}

fn extract_named_handlers(
    expr: &Expression<'_>,
    local_identifiers: &HashSet<String>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
    kind: &str,
) -> Vec<ExtractedCommandDefinition> {
    let Some(object) = get_object_expr(expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-handler-table",
            format!("{} table must be an object literal", kind),
            "src/package.ts",
            Some(expr.span()),
            source_text,
        ));
        return Vec::new();
    };

    let mut entries = Vec::new();
    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            continue;
        };
        if prop.computed {
            diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "computed-handler-key",
                format!("{} keys must be static", kind),
                "src/package.ts",
                Some(prop.span),
                source_text,
            ));
            continue;
        }
        let Some(name) = static_property_name(prop, source_text) else {
            continue;
        };
        let Some(handler) = extract_handler_reference(&prop.value, local_identifiers, source_text, diagnostics) else {
            continue;
        };
        entries.push(ExtractedCommandDefinition { name, handler });
    }
    entries
}

fn extract_app_definition(
    expr: &Expression<'_>,
    local_identifiers: &HashSet<String>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedAppDefinition> {
    let Some(object) = get_object_expr(expr) else {
        diagnostics.push(simple_diagnostic(
            PackageDiagnosticSeverity::Error,
            "non-literal-app",
            "app must be an object literal".to_string(),
            "src/package.ts",
            Some(expr.span()),
            source_text,
        ));
        return None;
    };

    let mut handler = None;
    for property in object.properties.iter() {
        let ObjectPropertyKind::ObjectProperty(prop) = property else {
            continue;
        };
        if prop.computed {
            continue;
        }
        let Some(key) = static_property_name(prop, source_text) else {
            continue;
        };
        match key.as_str() {
            "fetch" => {
                handler = extract_handler_reference(&prop.value, local_identifiers, source_text, diagnostics)
            }
            other => diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unknown-app-key",
                format!("unsupported app property: {}", other),
                "src/package.ts",
                Some(prop.span),
                source_text,
            )),
        }
    }

    handler.map(|handler| ExtractedAppDefinition { handler })
}

fn extract_handler_reference(
    expr: &Expression<'_>,
    local_identifiers: &HashSet<String>,
    source_text: &str,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Option<ExtractedHandlerReference> {
    match expr {
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
            Some(ExtractedHandlerReference {
                kind: ExtractedHandlerReferenceKind::InlineFunction,
                export_name: "default".to_string(),
                path: "src/package.ts".to_string(),
                local_name: None,
            })
        }
        Expression::Identifier(identifier) => {
            let name = identifier.name.to_string();
            if !local_identifiers.contains(&name) {
                diagnostics.push(simple_diagnostic(
                    PackageDiagnosticSeverity::Error,
                    "unknown-handler-identifier",
                    format!("handler identifier is not declared in src/package.ts: {}", name),
                    "src/package.ts",
                    Some(expr.span()),
                    source_text,
                ));
                return None;
            }
            Some(ExtractedHandlerReference {
                kind: ExtractedHandlerReferenceKind::LocalIdentifier,
                export_name: "default".to_string(),
                path: "src/package.ts".to_string(),
                local_name: Some(name),
            })
        }
        _ => {
            diagnostics.push(simple_diagnostic(
                PackageDiagnosticSeverity::Error,
                "unsupported-handler-shape",
                "handler must be an inline function or same-module identifier".to_string(),
                "src/package.ts",
                Some(expr.span()),
                source_text,
            ));
            None
        }
    }
}

fn is_define_package_call(call_expr: &CallExpression<'_>) -> bool {
    matches!(&call_expr.callee, Expression::Identifier(identifier) if identifier.name == "definePackage")
}

fn get_object_expr<'a>(expr: &'a Expression<'a>) -> Option<&'a oxc_ast::ast::ObjectExpression<'a>> {
    match expr {
        Expression::ObjectExpression(object) => Some(object),
        _ => None,
    }
}

fn static_property_name(prop: &ObjectProperty<'_>, source_text: &str) -> Option<String> {
    prop.key.static_name().map(|name| name.to_string()).or_else(|| {
        let span = prop.key.span();
        let slice = slice_span(source_text, span).trim();
        if let Some(stripped) = slice.strip_prefix('"').and_then(|value| value.strip_suffix('"')) {
            return Some(stripped.to_string());
        }
        if let Some(stripped) = slice.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')) {
            return Some(stripped.to_string());
        }
        None
    })
}

fn extract_string_literal(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

fn extract_u32_literal(expr: &Expression<'_>) -> Option<u32> {
    match expr {
        Expression::NumericLiteral(literal) if literal.value >= 0.0 => Some(literal.value as u32),
        _ => None,
    }
}

fn extract_string_array(expr: &Expression<'_>) -> Option<Vec<String>> {
    let Expression::ArrayExpression(array) = expr else {
        return None;
    };

    let mut values = Vec::new();
    for element in array.elements.iter() {
        let expression = element.as_expression()?;
        let value = extract_string_literal(expression)?;
        values.push(value);
    }
    Some(values)
}

fn simple_diagnostic(
    severity: PackageDiagnosticSeverity,
    code: &str,
    message: String,
    path: &str,
    span: Option<Span>,
    source_text: &str,
) -> PackageDiagnostic {
    let (line, column) = span
        .map(|value| line_column_for_offset(source_text, value.start as usize))
        .unwrap_or((1, 1));
    PackageDiagnostic {
        severity,
        code: code.to_string(),
        message,
        path: path.to_string(),
        line,
        column,
    }
}

fn line_column_for_offset(source_text: &str, offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut column = 1u32;
    for (index, ch) in source_text.char_indices() {
        if index >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn slice_span<'a>(source_text: &'a str, span: Span) -> &'a str {
    let start = span.start as usize;
    let end = span.end as usize;
    &source_text[start.min(source_text.len())..end.min(source_text.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_source() -> ResolvedPackageSource {
        ResolvedPackageSource {
            repo: "system/gsv".to_string(),
            requested_ref: "main".to_string(),
            resolved_commit: "abc123".to_string(),
            subdir: "gateway-os/packages/doctor".to_string(),
        }
    }

    #[test]
    fn normalize_subdir_rejects_parent_segments() {
        assert!(normalize_subdir("../bad").is_err());
        assert_eq!(
            normalize_subdir("./gateway-os//packages/doctor").unwrap(),
            "gateway-os/packages/doctor"
        );
    }

    #[test]
    fn analyze_package_source_extracts_direct_default_export() {
        let package_json = r#"{
          "name": "@gsv/doctor",
          "version": "0.1.0",
          "type": "module"
        }"#;
        let package_ts = r#"
          import { definePackage } from "@gsv/package-worker";

          async function doctor(ctx) {
            await ctx.stdout.write("ok\n");
          }

          export default definePackage({
            meta: {
              displayName: "Doctor",
              description: "Status checks",
              icon: "./ui/icon.svg",
              window: { width: 800, height: 600, minWidth: 320, minHeight: 240 },
              capabilities: {
                kernel: ["fs.read"],
                outbound: ["https://*"],
              },
            },
            commands: {
              doctor,
            },
            tasks: {
              refresh: async (ctx) => { void ctx; },
            },
          });
        "#;

        let analysis = analyze_package_source(sample_source(), package_json.to_string(), package_ts.to_string()).unwrap();
        assert!(analysis.ok);
        let definition = analysis.definition.unwrap();
        assert_eq!(definition.meta.display_name, "Doctor");
        assert_eq!(definition.commands.len(), 1);
        assert_eq!(definition.commands[0].name, "doctor");
        assert_eq!(definition.tasks.len(), 1);
        assert_eq!(analysis.identity.package_json_name, "@gsv/doctor");
    }

    #[test]
    fn analyze_package_source_supports_local_const_export() {
        let package_json = r#"{ "name": "@gsv/example" }"#;
        let package_ts = r#"
          import { definePackage } from "@gsv/package-worker";
          const setup = async (ctx) => { void ctx; };
          const pkg = definePackage({
            meta: { displayName: "Example" },
            setup,
            app: {
              fetch: async (request, ctx) => new Response("ok"),
            },
          });
          export default pkg;
        "#;

        let analysis = analyze_package_source(sample_source(), package_json.to_string(), package_ts.to_string()).unwrap();
        assert!(analysis.ok);
        let definition = analysis.definition.unwrap();
        assert!(definition.app.is_some());
        assert!(definition.setup.is_some());
    }

    #[test]
    fn analyze_package_source_reports_missing_import() {
        let package_json = r#"{ "name": "@gsv/example" }"#;
        let package_ts = r#"
          export default definePackage({
            meta: { displayName: "Example" },
          });
        "#;

        let analysis = analyze_package_source(sample_source(), package_json.to_string(), package_ts.to_string()).unwrap();
        assert!(!analysis.ok);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|d| d.code == "missing-define-package-import"));
    }

    #[test]
    fn analyze_package_source_reports_non_literal_display_name() {
        let package_json = r#"{ "name": "@gsv/example" }"#;
        let package_ts = r#"
          import { definePackage } from "@gsv/package-worker";
          const title = "Example";
          export default definePackage({
            meta: {
              displayName: title,
            },
          });
        "#;

        let analysis = analyze_package_source(sample_source(), package_json.to_string(), package_ts.to_string()).unwrap();
        assert!(!analysis.ok);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|d| d.code == "missing-display-name"));
    }
}
