use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub enum ServerRoot {
    Owned { directory: PathBuf, pid: u32 },
    Shared { pid: u32 },
}

#[derive(Serialize)]
pub struct DetectedServer {
    port: u16,
    url: String,
}

fn within_worktree(cwd: &Path, directory: &Path) -> bool {
    let Ok(cwd) = cwd.canonicalize() else {
        return false;
    };
    #[cfg(windows)]
    {
        let cwd = PathBuf::from(cwd.to_string_lossy().to_lowercase());
        let directory = PathBuf::from(directory.to_string_lossy().to_lowercase());
        cwd.starts_with(directory)
    }
    #[cfg(not(windows))]
    cwd.starts_with(directory)
}

fn belongs_to_worktree(pid: u32, roots: &[ServerRoot], system: &System, directory: &Path) -> bool {
    let listener = system.process(Pid::from_u32(pid));
    let listener_in_worktree = listener
        .and_then(|process| process.cwd())
        .is_some_and(|cwd| within_worktree(cwd, directory));
    let mut current = Some(Pid::from_u32(pid));
    for _ in 0..64 {
        let Some(id) = current else { return false };
        for root in roots {
            match root {
                ServerRoot::Owned {
                    directory: owner,
                    pid: root_pid,
                } if id.as_u32() == *root_pid && owner == directory && listener_in_worktree => {
                    return true
                }
                ServerRoot::Shared { pid: root_pid }
                    if id.as_u32() == *root_pid && id.as_u32() != pid && listener_in_worktree =>
                {
                    return true
                }
                _ => {}
            }
        }
        current = system.process(id).and_then(|process| process.parent());
    }
    false
}

fn local_address(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(ip) if ip.is_unspecified() => std::net::Ipv4Addr::LOCALHOST.into(),
        IpAddr::V6(ip) if ip.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
        _ => address,
    }
}

fn is_http(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    if stream
        .write_all(b"HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0; 7];
    stream.read_exact(&mut response).is_ok() && response == *b"HTTP/1."
}

pub fn detect(directory: &Path, roots: &[ServerRoot]) -> Result<Vec<DetectedServer>, String> {
    let directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    let sockets = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP,
    )
    .map_err(|error| error.to_string())?;
    let mut candidates: BTreeMap<u16, Vec<SocketAddr>> = BTreeMap::new();
    for socket in sockets {
        let ProtocolSocketInfo::Tcp(tcp) = socket.protocol_socket_info else {
            continue;
        };
        if tcp.state != TcpState::Listen || tcp.local_port == 0 {
            continue;
        }
        if socket
            .associated_pids
            .iter()
            .any(|pid| belongs_to_worktree(*pid, roots, &system, &directory))
        {
            let address = SocketAddr::new(local_address(tcp.local_addr), tcp.local_port);
            let addresses = candidates.entry(tcp.local_port).or_default();
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
    }
    Ok(candidates
        .into_iter()
        .filter_map(|(port, addresses)| {
            addresses
                .into_iter()
                .find(|address| is_http(*address))
                .map(|address| DetectedServer {
                    port,
                    url: format!("http://{address}/"),
                })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{detect, ServerRoot};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn lists_only_http_ports_owned_by_the_worktree() {
        let directory = std::env::current_dir().unwrap().canonicalize().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 128];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        assert!(!detect(&directory, &[])
            .unwrap()
            .iter()
            .any(|server| server.port == port));
        let roots = [ServerRoot::Owned {
            directory: directory.clone(),
            pid: std::process::id(),
        }];
        assert!(detect(&directory, &roots)
            .unwrap()
            .iter()
            .any(|server| server.port == port));
        server.join().unwrap();
    }
}
