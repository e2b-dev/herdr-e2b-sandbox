use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(serde::Deserialize)]
pub(crate) struct DashboardSettings {
    pub(crate) theme: String,
    pub(crate) opener: String,
    pub(crate) domain: String,
    /// Where the popup's Enter opens a box: below · right · above · left · tab. Empty (an older
    /// resolver) means the TUI keeps its default.
    #[serde(default)]
    pub(crate) popup_open: String,
}

pub(crate) fn dashboard_settings() -> Option<DashboardSettings> {
    let command = std::env::var_os("E2B_DASH_SETTINGS_CMD")?;
    let output = Command::new(command).arg("--settings").output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct DisplaySettings {
    pub(crate) theme: String,
    pub(crate) domain: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CacheEntry {
    config_dir: PathBuf,
    display: DisplaySettings,
}

// A single small record bounds both startup reads and storage. Switching config
// directories is a cache miss; cached display values never supply an opener.
pub(crate) struct DisplayCache {
    path: PathBuf,
    config_dir: PathBuf,
}

const MAX_CACHE_BYTES: u64 = 16 * 1024;

impl DisplayCache {
    pub(crate) fn new(state_dir: &Path, config_dir: &Path) -> Self {
        Self {
            path: state_dir.join("dashboard-display.json"),
            config_dir: std::path::absolute(config_dir).unwrap_or_else(|_| config_dir.to_owned()),
        }
    }

    pub(crate) fn load(&self) -> Option<DisplaySettings> {
        if !fs::metadata(&self.path).ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        File::open(&self.path)
            .ok()?
            .take(MAX_CACHE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_CACHE_BYTES {
            return None;
        }
        let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
        (entry.config_dir == self.config_dir).then_some(entry.display)
    }

    // Called only by the background resolver. An interrupted write leaves the
    // previous snapshot intact, and cache failures never prevent opening the UI.
    pub(crate) fn store(&self, settings: &DashboardSettings) {
        let entry = CacheEntry {
            config_dir: self.config_dir.clone(),
            display: DisplaySettings {
                theme: settings.theme.clone(),
                domain: settings.domain.clone(),
            },
        };
        let Ok(bytes) = serde_json::to_vec(&entry) else {
            return;
        };
        if bytes.len() as u64 > MAX_CACHE_BYTES {
            return;
        }
        let Some(dir) = self.path.parent() else {
            return;
        };
        if fs::create_dir_all(dir).is_err() {
            return;
        }
        static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);
        let temp = dir.join(format!(
            ".dashboard-display-{}-{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let Ok(mut file) = OpenOptions::new().write(true).create_new(true).open(&temp) else {
            return;
        };
        let written = file.write_all(&bytes);
        drop(file);
        if written.is_err() || fs::rename(&temp, &self.path).is_err() {
            let _ = fs::remove_file(temp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT_TEST: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "e2b-dash-display-cache-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn cache(&self, config: &str) -> DisplayCache {
            DisplayCache::new(&self.0, &self.0.join(config))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn settings(theme: &str, domain: &str) -> DashboardSettings {
        DashboardSettings {
            theme: theme.into(),
            domain: domain.into(),
            opener: "never persist this command or its secret argument".into(),
            popup_open: String::new(),
        }
    }

    #[test]
    fn cached_display_is_isolated_by_config_directory() {
        let fixture = Fixture::new();
        let first = fixture.cache("first-config");
        let second = fixture.cache("second-config");
        assert!(first.load().is_none());
        first.store(&settings("dracula", "e2b-juliett.dev"));
        assert_eq!(first.load().unwrap().theme, "dracula");
        assert!(second.load().is_none());
        second.store(&settings("nord", "e2b.dev"));
        assert_eq!(second.load().unwrap().theme, "nord");
        assert!(first.load().is_none());
    }

    #[test]
    fn cache_persists_only_display_values() {
        let fixture = Fixture::new();
        let cache = fixture.cache("config");
        let resolved = settings("dracula", "e2b-juliett.dev");
        cache.store(&resolved);
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&cache.path).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "config_dir": cache.config_dir,
                "display": { "theme": "dracula", "domain": "e2b-juliett.dev" }
            })
        );
        cache.store(&settings("nord", "e2b.dev"));
        assert_eq!(cache.load().unwrap().domain, "e2b.dev");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn malformed_or_oversized_cache_is_a_miss() {
        let fixture = Fixture::new();
        let cache = fixture.cache("config");
        for invalid in ["not json", "{}", "{\"display\":{\"theme\":false}}"] {
            fs::write(&cache.path, invalid).unwrap();
            assert!(cache.load().is_none());
        }
        cache.store(&settings("dracula", "e2b-juliett.dev"));
        OpenOptions::new()
            .append(true)
            .open(&cache.path)
            .unwrap()
            .write_all(&vec![b' '; MAX_CACHE_BYTES as usize])
            .unwrap();
        assert!(cache.load().is_none());
        cache.store(&settings("nord", "e2b.dev"));
        assert_eq!(cache.load().unwrap().theme, "nord");
    }

    #[test]
    fn unwritable_cache_does_not_fail_startup() {
        let fixture = Fixture::new();
        let state_file = fixture.0.join("state-file");
        fs::write(&state_file, "not a directory").unwrap();
        let cache = DisplayCache::new(&state_file, &fixture.0);
        cache.store(&settings("nord", "e2b.dev"));
        assert!(cache.load().is_none());
    }
}
