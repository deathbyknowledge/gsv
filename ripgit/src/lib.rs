mod api;
mod diff;
mod git;
mod hyperspace;
mod pack;
mod packages;
mod schema;
mod store;

use worker::*;

/// Delta compression keyframe interval. A full keyframe is stored every N
/// versions within a blob group. Worst-case reconstruction applies N-1 deltas.
pub const KEYFRAME_INTERVAL: i64 = 50;

struct Actor {
    display_name: String,
}

fn actor_from_request(req: &Request) -> Option<Actor> {
    let name = req.headers().get("X-Ripgit-Actor-Name").ok()??;
    Some(Actor { display_name: name })
}

fn check_write_access(
    _req: &Request,
    actor: &Option<Actor>,
    _repo_owner: &str,
) -> Option<Result<Response>> {
    match actor {
        Some(_) => None,
        None => Some(unauthorized_401()),
    }
}

fn unauthorized_401() -> Result<Response> {
    let mut resp = Response::error("Unauthorized: sign in to push", 401)?;
    resp.headers_mut()
        .set("WWW-Authenticate", r#"Basic realm="ripgit""#)?;
    Ok(resp)
}

async fn forward_hyperspace_request(
    mut req: Request,
    env: &Env,
    url: &Url,
    parts: &[&str],
) -> Result<Response> {
    let owner = parts[2];
    let repo = parts[3];
    let do_name = format!("{}/{}", owner, repo);
    let namespace = env.durable_object("REPOSITORY")?;
    let id = namespace.id_from_name(&do_name)?;
    let stub = id.get_stub()?;

    let mut target_path = format!("/{}/{}/hyperspace", owner, repo);
    if parts.len() > 4 {
        target_path.push('/');
        target_path.push_str(&parts[4..].join("/"));
    }
    if let Some(query) = url.query() {
        target_path.push('?');
        target_path.push_str(query);
    }

    let target_url = format!("{}{}", url.origin().ascii_serialization(), target_path);
    let method = req.method();
    let headers = req.headers().clone();
    let mut init = RequestInit::new();
    init.with_method(method.clone());
    init.with_headers(headers);
    if !matches!(method, Method::Get | Method::Head) {
        let body = req.bytes().await?;
        init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
    }

    let forwarded = Request::new_with_init(&target_url, &init)?;
    stub.fetch_with_request(forwarded).await
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();

    if parts.len() >= 4
        && parts[0] == "hyperspace"
        && parts[1] == "repos"
        && !parts[2].is_empty()
        && !parts[3].is_empty()
    {
        return forward_hyperspace_request(req, &env, &url, &parts).await;
    }

    if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        let do_name = format!("{}/{}", parts[0], parts[1]);
        let namespace = env.durable_object("REPOSITORY")?;
        let id = namespace.id_from_name(&do_name)?;
        let stub = id.get_stub()?;
        return stub.fetch_with_request(req).await;
    }

    Response::from_json(&serde_json::json!({
        "name": "ripgit",
        "version": "0.1.1",
        "description": "Git remote backed by Cloudflare Durable Objects"
    }))
}

#[durable_object]
pub struct Repository {
    state: State,
    sql: SqlStorage,
    #[allow(dead_code)]
    env: Env,
}

impl DurableObject for Repository {
    fn new(state: State, env: Env) -> Self {
        let state = state;
        let sql = state.storage().sql();
        schema::init(&sql);
        Self { sql, env, state }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path();
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();

        if parts.len() < 2 {
            return Response::error("Not Found", 404);
        }

        let owner = parts[0];
        let repo_name = parts[1];
        let repo_slug = format!("{}/{}", owner, repo_name);
        let action = if parts.len() >= 3 { parts[2] } else { "" };
        let actor = actor_from_request(&req);

        match (req.method(), action) {
            (Method::Get, "hyperspace") | (Method::Post, "hyperspace") => {
                if let Some(resp) = hyperspace::check_internal_access(&req, &self.env) {
                    return resp;
                }
                match parts.get(3).copied().unwrap_or("") {
                    "read" if req.method() == Method::Get => {
                        hyperspace::handle_read(&self.sql, &req).await
                    }
                    "refs" if req.method() == Method::Get => api::handle_refs(&self.sql),
                    "log" if req.method() == Method::Get => {
                        let url = req.url()?;
                        api::handle_log(&self.sql, &url)
                    }
                    "search" if req.method() == Method::Get => {
                        hyperspace::handle_search(&self.sql, &req).await
                    }
                    "compare" if req.method() == Method::Get => {
                        hyperspace::handle_compare(&self.sql, &req).await
                    }
                    "apply" if req.method() == Method::Post => {
                        hyperspace::handle_apply(&self.sql, &mut req).await
                    }
                    "import" if req.method() == Method::Post => {
                        hyperspace::handle_import(&self.sql, &mut req).await
                    }
                    "packages" => match (req.method(), parts.get(4).copied().unwrap_or("")) {
                        (Method::Get, "analyze") => {
                            hyperspace::handle_packages_analyze(&self.sql, &req, &repo_slug).await
                        }
                        (Method::Get, "snapshot") => {
                            hyperspace::handle_packages_snapshot(&self.sql, &req, &repo_slug).await
                        }
                        _ => Response::error("Not Found", 404),
                    },
                    _ => Response::error("Not Found", 404),
                }
            }
            (Method::Get, "info") if parts.get(3) == Some(&"refs") => {
                let service = url
                    .query_pairs()
                    .find(|(k, _)| k == "service")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                match service.as_str() {
                    "git-receive-pack" => {
                        if let Some(resp) = check_write_access(&req, &actor, owner) {
                            return resp;
                        }
                        self.advertise_refs("git-receive-pack")
                    }
                    "git-upload-pack" => self.advertise_refs("git-upload-pack"),
                    _ => Response::error("Unsupported service", 403),
                }
            }
            (Method::Post, "git-receive-pack") => {
                if let Some(resp) = check_write_access(&req, &actor, owner) {
                    return resp;
                }
                let body = req.bytes().await?;
                git::handle_receive_pack(&self.sql, &body)
            }
            (Method::Post, "git-upload-pack") => {
                let body = req.bytes().await?;
                git::handle_upload_pack(&self.sql, &body)
            }
            (Method::Delete, "") => {
                if let Some(resp) = check_write_access(&req, &actor, owner) {
                    return resp;
                }
                self.state.storage().delete_all().await?;
                Response::ok("deleted")
            }
            (Method::Get, "refs") => api::handle_refs(&self.sql),
            (Method::Get, "file") => api::handle_file(&self.sql, &url),
            (Method::Get, "search") => api::handle_search(&self.sql, &url),
            (Method::Get, "stats") => api::handle_stats(&self.sql),
            (Method::Get, "diff") => {
                let sha = parts.get(3).unwrap_or(&"");
                diff::handle_diff(&self.sql, sha, &url)
            }
            (Method::Get, "compare") => {
                let spec = parts.get(3).unwrap_or(&"");
                diff::handle_compare(&self.sql, spec, &url)
            }
            (Method::Get, "log") => api::handle_log(&self.sql, &url),
            (Method::Get, "commit") => {
                let hash = parts.get(3).unwrap_or(&"");
                api::handle_commit(&self.sql, hash)
            }
            (Method::Get, "tree") if is_hex40(parts.get(3).unwrap_or(&"")) => {
                api::handle_tree(&self.sql, parts.get(3).unwrap_or(&""))
            }
            (Method::Get, "blob") if is_hex40(parts.get(3).unwrap_or(&"")) => {
                api::handle_blob(&self.sql, parts.get(3).unwrap_or(&""))
            }
            (Method::Put, "admin") => {
                if let Some(resp) = check_write_access(&req, &actor, owner) {
                    return resp;
                }
                let sub = parts.get(3).unwrap_or(&"");
                match *sub {
                    "set-ref" => {
                        let name = url
                            .query_pairs()
                            .find(|(k, _)| k == "name")
                            .map(|(_, v)| v.to_string());
                        let hash = url
                            .query_pairs()
                            .find(|(k, _)| k == "hash")
                            .map(|(_, v)| v.to_string());
                        match (name, hash) {
                            (Some(n), Some(h)) => {
                                self.sql.exec(
                                    "INSERT INTO refs (name, commit_hash) VALUES (?, ?)\n                                     ON CONFLICT(name) DO UPDATE SET commit_hash = ?",
                                    vec![
                                        SqlStorageValue::from(n.clone()),
                                        SqlStorageValue::from(h.clone()),
                                        SqlStorageValue::from(h.clone()),
                                    ],
                                )?;
                                Response::ok(format!("{} -> {}", n, h))
                            }
                            _ => Response::ok("need ?name=refs/heads/main&hash=abc123"),
                        }
                    }
                    "config" => {
                        let key = url
                            .query_pairs()
                            .find(|(k, _)| k == "key")
                            .map(|(_, v)| v.to_string());
                        let value = url
                            .query_pairs()
                            .find(|(k, _)| k == "value")
                            .map(|(_, v)| v.to_string());
                        match (key, value) {
                            (Some(k), Some(v)) => {
                                store::set_config(&self.sql, &k, &v)?;
                                Response::ok(format!("{} = {}", k, v))
                            }
                            (Some(k), None) => {
                                let v = store::get_config(&self.sql, &k)?;
                                Response::ok(v.unwrap_or_else(|| "(not set)".to_string()))
                            }
                            _ => Response::ok("need ?key=name[&value=val]"),
                        }
                    }
                    "rebuild-fts" => {
                        let default_ref = store::get_config(&self.sql, "default_branch")?
                            .unwrap_or_else(|| "refs/heads/main".to_string());
                        #[derive(serde::Deserialize)]
                        struct RefRow {
                            commit_hash: String,
                        }
                        let rows: Vec<RefRow> = self
                            .sql
                            .exec(
                                "SELECT commit_hash FROM refs WHERE name = ?",
                                vec![SqlStorageValue::from(default_ref)],
                            )?
                            .to_array()?;
                        if let Some(row) = rows.first() {
                            store::rebuild_fts_index(&self.sql, &row.commit_hash)?;
                            Response::ok("fts rebuilt")
                        } else {
                            Response::ok("no default branch ref found")
                        }
                    }
                    "rebuild-graph" => {
                        self.sql.exec("DELETE FROM commit_graph", None)?;
                        self.sql.exec(
                            "INSERT INTO commit_graph (commit_hash, level, ancestor_hash)\n                             SELECT cp.commit_hash, 0, cp.parent_hash\n                             FROM commit_parents cp WHERE cp.ordinal = 0",
                            None,
                        )?;

                        let mut level: i64 = 1;
                        loop {
                            let prev = level - 1;
                            let result = self.sql.exec(
                                &format!(
                                    "INSERT INTO commit_graph (commit_hash, level, ancestor_hash)\n                                     SELECT cg.commit_hash, {}, cg2.ancestor_hash\n                                     FROM commit_graph cg\n                                     JOIN commit_graph cg2\n                                       ON cg2.commit_hash = cg.ancestor_hash AND cg2.level = {}\n                                     WHERE cg.level = {}",
                                    level, prev, prev
                                ),
                                None,
                            )?;
                            if result.rows_written() == 0 {
                                break;
                            }
                            level += 1;
                        }

                        Response::ok(format!("commit graph rebuilt ({} levels)", level))
                    }
                    "rebuild-fts-commits" => {
                        self.sql.exec("DELETE FROM fts_commits", None)?;
                        self.sql.exec(
                            "INSERT INTO fts_commits (hash, message, author)\n                             SELECT hash, message, author FROM commits",
                            None,
                        )?;
                        #[derive(serde::Deserialize)]
                        struct Count {
                            n: i64,
                        }
                        let rows: Vec<Count> = self
                            .sql
                            .exec("SELECT COUNT(*) AS n FROM fts_commits", None)?
                            .to_array()?;
                        let n = rows.first().map(|r| r.n).unwrap_or(0);
                        Response::ok(format!("fts_commits rebuilt ({} entries)", n))
                    }
                    _ => Response::error("unknown admin action", 404),
                }
            }
            _ => Response::error("Not Found", 404),
        }
    }
}

impl Repository {
    fn advertise_refs(&self, service: &str) -> Result<Response> {
        let content_type = format!("application/x-{}-advertisement", service);

        #[derive(serde::Deserialize)]
        struct RefRow {
            name: String,
            commit_hash: String,
        }
        let refs: Vec<RefRow> = self
            .sql
            .exec("SELECT name, commit_hash FROM refs", None)?
            .to_array()?;

        let mut body = Vec::new();

        let svc_line = format!("# service={}\n", service);
        pkt_line(&mut body, &svc_line);
        body.extend_from_slice(b"0000");

        let default_branch = store::get_config(&self.sql, "default_branch")?
            .unwrap_or_else(|| "refs/heads/main".to_string());
        let caps = match service {
            "git-upload-pack" => format!(
                "multi_ack_detailed no-done ofs-delta side-band-64k no-progress symref=HEAD:{}",
                default_branch
            ),
            _ => format!(
                "report-status delete-refs ofs-delta side-band-64k quiet symref=HEAD:{}",
                default_branch
            ),
        };

        if refs.is_empty() {
            let line = format!(
                "0000000000000000000000000000000000000000 capabilities^{{}}\0{}\n",
                caps
            );
            pkt_line(&mut body, &line);
        } else {
            let head_hash = refs
                .iter()
                .find(|r| r.name == default_branch)
                .map(|r| r.commit_hash.clone());

            let mut first = true;

            if let Some(ref hh) = head_hash {
                let line = format!("{} HEAD\0{}\n", hh, caps);
                pkt_line(&mut body, &line);
                first = false;
            }

            for r in refs.iter() {
                let line = if first {
                    first = false;
                    format!("{} {}\0{}\n", r.commit_hash, r.name, caps)
                } else {
                    format!("{} {}\n", r.commit_hash, r.name)
                };
                pkt_line(&mut body, &line);
            }
        }
        body.extend_from_slice(b"0000");

        let mut resp = Response::from_bytes(body)?;
        resp.headers_mut().set("Content-Type", &content_type)?;
        resp.headers_mut().set("Cache-Control", "no-cache")?;
        Ok(resp)
    }
}

fn pkt_line(buf: &mut Vec<u8>, data: &str) {
    let len = 4 + data.len();
    buf.extend_from_slice(format!("{:04x}", len).as_bytes());
    buf.extend_from_slice(data.as_bytes());
}

fn is_hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
