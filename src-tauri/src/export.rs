//! `prv export`: a single self-contained HTML file (UI + data). Opens from
//! disk with `file://` — no server. Review comments can be copied for an AI agent.

use crate::git::{contents, read_blobs, Git, Resolved};
use serde_json::json;
use std::collections::BTreeMap;

pub const UI_HTML: &str = include_str!("../../ui/dist/index.html");
const MAX_TOTAL_CONTENT: usize = 40 * 1024 * 1024;

pub fn data_json(git: &Git, r: &Resolved) -> serde_json::Value {
    let s = &r.snapshot;
    let mut wanted: Vec<(String, Option<String>, String)> = vec![]; // (key, sha, path)
    for f in &s.files {
        if f.binary || f.submodule || f.too_large {
            continue;
        }
        if f.status != "added" {
            let p = f.old_path.clone().unwrap_or_else(|| f.path.clone());
            wanted.push((format!("old:{p}"), f.old_sha.clone(), p));
        }
        if f.status != "deleted" {
            wanted.push((format!("new:{}", f.path), f.new_sha.clone(), f.path.clone()));
        }
    }
    let shas: Vec<String> = wanted.iter().filter_map(|w| w.1.clone()).collect();
    let blobs = read_blobs(git, &shas);
    let mut map = BTreeMap::new();
    let mut total = 0usize;
    for (key, sha, path) in wanted {
        if total > MAX_TOTAL_CONTENT {
            break;
        }
        let text = match sha {
            Some(sha) => blobs.get(&sha).cloned(),
            None => contents(git, &r.ends, &s.files, &path, if key.starts_with("old:") { "old" } else { "new" }),
        };
        if let Some(text) = text {
            total += text.len();
            map.insert(key, text);
        }
    }
    json!({ "snapshot": s, "contents": map })
}

pub fn html(data: &serde_json::Value) -> String {
    let payload = serde_json::to_string(data)
        .unwrap_or_else(|_| "{}".into())
        // `<` as \u003c keeps `</script>` and `<!--` sequences from ending the script early.
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let script = format!("<script>window.__PRV_DATA__={payload};</script>");
    match UI_HTML.find("<script") {
        Some(i) => format!("{}{}{}", &UI_HTML[..i], script, &UI_HTML[i..]),
        None => format!("{UI_HTML}{script}"),
    }
}
