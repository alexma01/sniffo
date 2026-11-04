//! Update check: asks GitHub for the latest published release (drafts are never listed).
//! Nothing is downloaded or installed; the UI points the user at the release and `brew upgrade`.

use crate::Error;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const LATEST_URL: &str = "https://api.github.com/repos/alexma01/sniffo/releases/latest";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Update {
    pub current: String,
    pub version: String,
    pub url: String,
    pub notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    prerelease: bool,
}

fn parse(v: &str) -> Option<[u64; 3]> {
    let mut it = v.trim().trim_start_matches('v').split('.').map(|p| p.parse().ok());
    let v = [it.next()??, it.next()??, it.next()??];
    it.next().is_none().then_some(v)
}

/// Strictly newer `X.Y.Z`; anything unparsable counts as not newer.
pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(l), Some(c)) if l > c)
}

/// The latest release at `api_url` when it is newer than `current`.
pub async fn check(api_url: &str, current: &str) -> Result<Option<Update>, Error> {
    // Direct, not through Sniffo's own proxy: the check must not show up as captured traffic.
    let client = reqwest::Client::builder()
        .no_proxy()
        .user_agent(format!("Sniffo/{current}"))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(Error::other)?;
    let res = client.get(api_url).header("accept", "application/vnd.github+json").send().await.map_err(Error::other)?;
    let body = res.error_for_status().map_err(Error::other)?.text().await.map_err(Error::other)?;
    let release: Release = serde_json::from_str(&body).map_err(Error::other)?;
    let version = release.tag_name.trim_start_matches('v').to_owned();
    if release.prerelease || !is_newer(&version, current) {
        return Ok(None);
    }
    Ok(Some(Update { current: current.to_owned(), version, url: release.html_url, notes: release.body.unwrap_or_default() }))
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.2", "0.1.2"));
        assert!(!is_newer("0.1.1", "0.1.2"));
        assert!(!is_newer("0.2", "0.1.0"));
        assert!(!is_newer("0.2.0-beta", "0.1.0"));
        assert!(!is_newer("junk", "0.1.0"));
    }
}
