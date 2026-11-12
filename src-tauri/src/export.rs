//! `gh-prv-local export`: a single self-contained HTML file (UI + data). Opens from
//! disk with `file://` — no server. Review comments can be copied for an AI agent.

use crate::git::{contents, image, image_mime, read_blobs, Git, Resolved};
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
    // Images for the image diff, as data URLs, within the same budget.
    let mut images = BTreeMap::new();
    for f in s.files.iter().filter(|f| f.binary && image_mime(&f.path).is_some()) {
        let old = f.old_path.clone().unwrap_or_else(|| f.path.clone());
        for (side, path) in [("old", old), ("new", f.path.clone())] {
            if (side == "old" && f.status == "added") || (side == "new" && f.status == "deleted") || total > MAX_TOTAL_CONTENT {
                continue;
            }
            if let Some(url) = image(git, &r.ends, &s.files, &path, side) {
                total += url.len();
                images.insert(format!("{side}:{path}"), url);
            }
        }
    }
    json!({ "snapshot": s, "contents": map, "images": images })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An exported page restricts itself like the native window: nothing from other hosts.
    #[test]
    fn export_carries_the_window_csp() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        for directive in ["img-src", "font-src", "connect-src", "media-src", "default-src"] {
            let value = csp.split(';').map(str::trim).find(|d| d.starts_with(directive)).unwrap_or_default();
            // Tauri's IPC endpoint is the only http(s) source.
            let remote = value.split_whitespace().skip(1).any(|t| t.contains('*') || (t.starts_with("http") && t != "http://ipc.localhost"));
            assert!(!remote, "{value}");
        }
        let page = html(&json!({}));
        let head = &page[..page.find("<script").unwrap()];
        assert!(head.contains(&format!("content=\"{}\"", csp.replace('\'', "&#39;"))), "CSP meta missing before the first script");
        assert!(head.contains("<meta name=\"referrer\" content=\"no-referrer\">"));
    }
}
