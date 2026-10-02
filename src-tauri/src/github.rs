use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Serialize, Deserialize)]
pub struct PullRequest {
    number: u64,
    url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    name: String,
    state: String,
    url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestChecks {
    number: u64,
    url: String,
    checks: Vec<PullRequestCheck>,
}

#[derive(Deserialize)]
pub struct WorktreeBranch {
    path: String,
    branch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChecks {
    checks: HashMap<String, Option<PullRequestChecks>>,
    errors: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssue {
    number: u64,
    title: String,
    body: String,
    url: String,
}

fn gh_binary() -> OsString {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    if let Some(path) = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
    {
        return path.into_os_string();
    }
    let candidates = if cfg!(windows) {
        vec![PathBuf::from(r"C:\Program Files\GitHub CLI\gh.exe")]
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin/gh"),
            PathBuf::from("/usr/local/bin/gh"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map_or_else(|| OsString::from(name), PathBuf::into_os_string)
}

fn run(directory: &Path, binary: &str, args: &[&str]) -> Result<Output, String> {
    Command::new(binary)
        .current_dir(directory)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Cannot start {binary}: {error}"))
}

fn output_or_error(output: Output, action: &str) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "{action}: {}",
            if error.is_empty() {
                "Command failed"
            } else {
                &error
            }
        ))
    }
}

fn github_remote(url: &str) -> Option<String> {
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))?
        .trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn gh_command(directory: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(gh_binary())
        .current_dir(directory)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Cannot start GitHub CLI: {error}"))?;
    output_or_error(output, "GitHub CLI failed")
}

fn pull_request_repos(
    worktree: &Path,
    remote: &str,
    branch: &str,
) -> Result<(String, String), String> {
    let source = source_repository(worktree, remote)?;
    let target = target_repository(worktree)?;
    let head = if source.eq_ignore_ascii_case(&target) {
        branch.to_string()
    } else {
        format!("{}:{branch}", source.split('/').next().unwrap_or_default())
    };
    Ok((target, head))
}

fn source_repository(worktree: &Path, remote: &str) -> Result<String, String> {
    let remote_url = output_or_error(
        run(worktree, "git", &["remote", "get-url", "--push", remote])?,
        "Cannot find push remote",
    )?;
    github_remote(&remote_url).ok_or("Push remote must be a github.com repository.".to_string())
}

fn target_repository(worktree: &Path) -> Result<String, String> {
    let repository = gh_command(
        worktree,
        &["repo", "view", "--json", "nameWithOwner,isFork,parent"],
    )?;
    let repository: serde_json::Value = serde_json::from_str(&repository)
        .map_err(|_| "GitHub CLI returned an invalid repository.".to_string())?;
    let selected = repository["nameWithOwner"]
        .as_str()
        .ok_or("GitHub CLI returned an invalid repository.")?;
    let target = if repository["isFork"].as_bool() == Some(true) {
        repository["parent"]["nameWithOwner"]
            .as_str()
            .unwrap_or(selected)
    } else {
        selected
    };
    Ok(target.to_string())
}

fn issue_repository(repository: String) -> Result<(PathBuf, String), String> {
    let repository = PathBuf::from(crate::validate_repository(repository)?);
    let remotes = output_or_error(run(&repository, "git", &["remote"])?, "Cannot list remotes")?;
    let has_github_remote = remotes.lines().any(|remote| {
        run(&repository, "git", &["remote", "get-url", remote])
            .ok()
            .and_then(|output| output_or_error(output, "Cannot read remote").ok())
            .and_then(|url| github_remote(&url))
            .is_some()
    });
    if !has_github_remote {
        return Err("This project has no github.com remote. Add one to browse issues.".to_string());
    }
    let target = target_repository(&repository)?;
    Ok((repository, target))
}

#[tauri::command]
pub async fn list_open_issues(
    repository: String,
    query: String,
) -> Result<Vec<GitHubIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (repository, target) = issue_repository(repository)?;
        let query = query.trim();
        if query.len() > 200 {
            return Err("Issue search is too long.".to_string());
        }
        let mut args = vec![
            "issue",
            "list",
            "--repo",
            &target,
            "--state",
            "open",
            "--limit",
            "30",
            "--json",
            "number,title,body,url",
        ];
        if !query.is_empty() {
            args.extend(["--search", query]);
        }
        let response = gh_command(&repository, &args)?;
        serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned invalid issues.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_issue(repository: String, number: u64) -> Result<GitHubIssue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 {
            return Err("Choose an issue.".to_string());
        }
        let (repository, target) = issue_repository(repository)?;
        let number = number.to_string();
        let response = gh_command(
            &repository,
            &[
                "issue",
                "view",
                &number,
                "--repo",
                &target,
                "--json",
                "number,title,body,url,state",
            ],
        )?;
        let value: serde_json::Value = serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned an invalid issue.".to_string())?;
        if value["state"] != "OPEN" {
            return Err("This issue is no longer open. Search again.".to_string());
        }
        serde_json::from_value(value)
            .map_err(|_| "GitHub CLI returned an invalid issue.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn checked_worktree(repository: String, worktree: String, branch: &str) -> Result<PathBuf, String> {
    let repository = PathBuf::from(crate::validate_repository(repository)?);
    let worktree = Path::new(&worktree)
        .canonicalize()
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    let listed = crate::git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    if worktree == repository
        || !listed
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .any(|path| {
                Path::new(path)
                    .canonicalize()
                    .is_ok_and(|registered| registered == worktree)
            })
    {
        return Err("This folder is not a worktree of the selected repository.".to_string());
    }
    let actual = crate::git_reference(&worktree, &["symbolic-ref", "--short", "HEAD"])
        .ok_or("Worktree has no active branch.".to_string())?;
    if actual != branch {
        return Err(format!(
            "Worktree branch changed to {actual}. Refresh the repository."
        ));
    }
    Ok(worktree)
}

#[tauri::command]
pub async fn pull_request_checks(
    repository: String,
    worktrees: Vec<WorktreeBranch>,
) -> Result<RepositoryChecks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        let target = target_repository(Path::new(&repository))?;
        let response = gh_command(
            Path::new(&repository),
            &[
                "pr",
                "list",
                "--repo",
                &target,
                "--state",
                "open",
                "--limit",
                "500",
                "--json",
                "number,url,statusCheckRollup,headRepositoryOwner,headRefName",
            ],
        )?;
        let prs: Vec<serde_json::Value> = serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned invalid pull request checks.".to_string())?;
        let mut checks = HashMap::new();
        let mut errors = HashMap::new();
        for entry in worktrees {
            let result = (|| {
                let worktree =
                    checked_worktree(repository.clone(), entry.path.clone(), &entry.branch)?;
                let remote = branch_remote(&worktree, &entry.branch)?;
                let source = source_repository(&worktree, &remote)?;
                let owner = source.split('/').next().unwrap_or_default();
                let Some(pr) = prs.iter().find(|pr| {
                    pr["headRefName"].as_str() == Some(&entry.branch)
                        && pr["headRepositoryOwner"]["login"]
                            .as_str()
                            .is_some_and(|login| login.eq_ignore_ascii_case(owner))
                }) else {
                    return Ok(None);
                };
                Ok(Some(parse_pull_request_checks(pr)?))
            })();
            match result {
                Ok(pr) => {
                    checks.insert(entry.path, pr);
                }
                Err(cause) => {
                    errors.insert(entry.path, cause);
                }
            }
        }
        Ok(RepositoryChecks { checks, errors })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn branch_remote(worktree: &Path, branch: &str) -> Result<String, String> {
    let remote = run(
        worktree,
        "git",
        &["config", "--get", &format!("branch.{branch}.remote")],
    )?;
    if remote.status.success() {
        output_or_error(remote, "Cannot find branch remote")
    } else {
        Ok("origin".to_string())
    }
}

fn parse_pull_request_checks(pr: &serde_json::Value) -> Result<PullRequestChecks, String> {
    let number = pr["number"].as_u64().ok_or("Pull request has no number.")?;
    let url = pr["url"]
        .as_str()
        .ok_or("Pull request has no link.")?
        .to_string();
    let checks = pr["statusCheckRollup"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|check| {
            let state = if check["__typename"] == "StatusContext" {
                check["state"].as_str().unwrap_or("PENDING")
            } else if check["status"] != "COMPLETED" {
                "PENDING"
            } else {
                check["conclusion"].as_str().unwrap_or("PENDING")
            };
            PullRequestCheck {
                name: check["name"]
                    .as_str()
                    .or_else(|| check["context"].as_str())
                    .unwrap_or("Unknown check")
                    .to_string(),
                state: state.to_string(),
                url: check["detailsUrl"]
                    .as_str()
                    .or_else(|| check["targetUrl"].as_str())
                    .unwrap_or("")
                    .to_string(),
            }
        })
        .collect();
    Ok(PullRequestChecks {
        number,
        url,
        checks,
    })
}

#[tauri::command]
pub async fn failed_check_log(
    repository: String,
    worktree: String,
    branch: String,
    url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = checked_worktree(repository, worktree, &branch)?;
        let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid check link.")?;
        let parts = parsed
            .path_segments()
            .ok_or("Invalid check link.")?
            .collect::<Vec<_>>();
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || parts.len() != 7
            || parts[2] != "actions"
            || parts[3] != "runs"
            || parts[5] != "job"
            || parts[4].parse::<u64>().is_err()
            || parts[6].parse::<u64>().is_err()
        {
            return Err("This check has no GitHub Actions job log. Open its link instead.".into());
        }
        let check_repo = format!("{}/{}", parts[0], parts[1]);
        let remote = branch_remote(&worktree, &branch)?;
        let source = source_repository(&worktree, &remote)?;
        let target = target_repository(&worktree)?;
        if !check_repo.eq_ignore_ascii_case(&source) && !check_repo.eq_ignore_ascii_case(&target) {
            return Err("Check log belongs to another repository.".to_string());
        }
        let log = gh_command(
            &worktree,
            &[
                "run",
                "view",
                parts[4],
                "--repo",
                &check_repo,
                "--job",
                parts[6],
                "--log",
            ],
        )?;
        let start = log
            .char_indices()
            .rev()
            .nth(99_999)
            .map_or(0, |(index, _)| index);
        Ok(log[start..].to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_pull_request(
    repository: String,
    worktree: String,
    branch: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<PullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = checked_worktree(repository, worktree, &branch)?;
        let base = base.trim();
        let title = title.trim();
        if base.is_empty() || base.starts_with('-') || title.is_empty() {
            return Err("Enter a base branch and pull request title.".to_string());
        }
        let upstream = run(
            &worktree,
            "git",
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )?;
        let remote = if upstream.status.success() {
            output_or_error(
                run(
                    &worktree,
                    "git",
                    &["config", "--get", &format!("branch.{branch}.remote")],
                )?,
                "Cannot find upstream remote",
            )?
        } else {
            "origin".to_string()
        };
        if upstream.status.success() {
            output_or_error(run(&worktree, "git", &["push"])?, "Cannot push branch")?;
        } else {
            output_or_error(
                run(&worktree, "git", &["push", "-u", &remote, &branch])?,
                "Cannot push branch",
            )?;
        }
        let (target, head) = pull_request_repos(&worktree, &remote, &branch)?;
        let gh = gh_binary();
        let mut command = Command::new(&gh);
        command
            .current_dir(&worktree)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "pr", "create", "--repo", &target, "--base", base, "--head", &head, "--title",
                title, "--body", &body,
            ]);
        if draft {
            command.arg("--draft");
        }
        let output = output_or_error(
            command
                .output()
                .map_err(|error| format!("Cannot start GitHub CLI: {error}"))?,
            "Cannot create pull request",
        )?;
        let url = output.lines().last().unwrap_or_default();
        let parsed = tauri::Url::parse(url)
            .map_err(|_| "GitHub CLI returned an invalid pull request link.".to_string())?;
        let parts = parsed
            .path_segments()
            .ok_or("GitHub CLI returned an invalid pull request link.")?
            .collect::<Vec<_>>();
        let number = parts.get(3).and_then(|number| number.parse::<u64>().ok());
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || parts.len() != 4
            || parts[2] != "pull"
            || number.is_none_or(|number| number == 0)
        {
            return Err("GitHub CLI returned an invalid pull request link.".to_string());
        }
        Ok(PullRequest {
            number: number.unwrap_or_default(),
            url: url.to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_pull_request(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid pull request link.")?;
    let parts = parsed
        .path_segments()
        .ok_or("Invalid pull request link.")?
        .collect::<Vec<_>>();
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parts.len() != 4
        || parts[0].is_empty()
        || parts[1].is_empty()
        || parts[2] != "pull"
        || parts[3].parse::<u64>().is_err()
    {
        return Err("Invalid pull request link.".to_string());
    }
    open_url(url)
}

#[tauri::command]
pub fn open_check_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid check link.")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("Invalid check link.".to_string());
    }
    open_url(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_url(validate_external_url(&url)?)
}

fn validate_external_url(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid external link.")?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed.to_string()),
        "mailto" if !parsed.path().is_empty() => Ok(parsed.to_string()),
        _ => Err("Invalid external link.".to_string()),
    }
}

fn open_url(url: String) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("SAIL_E2E_OPEN_URL_LOG") {
        return std::fs::write(path, url).map_err(|error| error.to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    command
        .arg(url)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn external_links_use_browser_safe_schemes() {
        assert_eq!(
            validate_external_url("https://example.com/path").unwrap(),
            "https://example.com/path"
        );
        assert_eq!(
            validate_external_url("mailto:user@example.com").unwrap(),
            "mailto:user@example.com"
        );
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,bad",
            "//example.com",
            "http://",
            "mailto:",
        ] {
            assert!(validate_external_url(url).is_err(), "{url}");
        }
    }
}
