//! Outgoing connection options: upstream proxy, DNS overrides, lenient upstream TLS.

use hudsucker::rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use hyper_util::client::legacy::connect::dns::{GaiResolver, Name};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamKind {
    #[default]
    Http,
    Socks5,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Upstream {
    pub kind: UpstreamKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct NetworkOptions {
    /// Chain every decrypted/plain request through another proxy (corporate networks).
    #[serde(default)]
    pub upstream: Option<Upstream>,
    /// host -> IP, like /etc/hosts. Applies to direct connections.
    #[serde(default)]
    pub dns: Vec<(String, String)>,
    /// Accept any upstream certificate (self-signed dev servers). Dangerous; off by default.
    #[serde(default)]
    pub ignore_upstream_tls_errors: bool,
}

/// System DNS, except for overridden hosts.
#[derive(Clone)]
pub struct OverrideResolver {
    map: Arc<HashMap<String, IpAddr>>,
    gai: GaiResolver,
}

impl OverrideResolver {
    pub fn new(entries: &[(String, String)]) -> Result<Self, String> {
        let map = entries
            .iter()
            .map(|(h, ip)| ip.trim().parse().map(|ip| (h.trim().to_ascii_lowercase(), ip)).map_err(|_| format!("DNS override: '{ip}' is not an IP address")))
            .collect::<Result<_, _>>()?;
        Ok(Self { map: Arc::new(map), gai: GaiResolver::new() })
    }
}

type Addrs = Box<dyn Iterator<Item = SocketAddr> + Send>;

impl tower_service::Service<Name> for OverrideResolver {
    type Response = Addrs;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Addrs, std::io::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.gai.poll_ready(cx)
    }

    fn call(&mut self, name: Name) -> Self::Future {
        if let Some(ip) = self.map.get(&name.as_str().to_ascii_lowercase()) {
            let addr = SocketAddr::new(*ip, 0);
            return Box::pin(async move { Ok(Box::new(std::iter::once(addr)) as Addrs) });
        }
        let fut = self.gai.call(name);
        Box::pin(async move { Ok(Box::new(fut.await?) as Addrs) })
    }
}

/// Skips certificate validation but still checks handshake signatures with the real provider.
#[derive(Debug)]
pub struct NoVerify(pub Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, hudsucker::rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, hudsucker::rustls::Error> {
        hudsucker::rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, hudsucker::rustls::Error> {
        hudsucker::rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}
