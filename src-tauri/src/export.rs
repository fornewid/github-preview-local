//! `prv export`: a single self-contained HTML file (UI + data). Opens from
//! disk with `file://` — no server. Review comments can be copied for an AI agent.

use crate::git::{contents, Git, Resolved};
use serde_json::json;
use std::collections::BTreeMap;

pub const UI_HTML: &str = include_str!("../../ui/dist/index.html");
const MAX_TOTAL_CONTENT: usize = 40 * 1024 * 1024;

pub fn data_json(git: &Git, r: &Resolved) -> serde_json::Value {
    let mut map = BTreeMap::new();
    let mut total = 0usize;
    let s = &r.snapshot;
    for f in &s.files {
        if f.binary || f.submodule {
            continue;
        }
        let mut sides = vec![];
        if f.status != "added" {
            sides.push(("old", f.old_path.clone().unwrap_or_else(|| f.path.clone())));
        }
        if f.status != "deleted" {
            sides.push(("new", f.path.clone()));
        }
        for (side, path) in sides {
            if total > MAX_TOTAL_CONTENT {
                break;
            }
            if let Some(text) = contents(git, &r.ends, &s.files, &path, side) {
                total += text.len();
                map.insert(format!("{side}:{path}"), text);
            }
        }
    }
    json!({ "snapshot": s, "contents": map })
}

pub fn html(data: &serde_json::Value) -> String {
    let payload = serde_json::to_string(data)
        .unwrap_or_else(|_| "{}".into())
        .replace("</", "<\\/")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let script = format!("<script>window.__PRV_DATA__={payload};</script>");
    match UI_HTML.find("<script") {
        Some(i) => format!("{}{}{}", &UI_HTML[..i], script, &UI_HTML[i..]),
        None => format!("{UI_HTML}{script}"),
    }
}
