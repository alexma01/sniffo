//! Root certificate authority: generated once, persisted in the app data dir.

use hudsucker::rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use std::{fs, io, path::Path};

const CERT_FILE: &str = "sniffo-ca.pem";
const KEY_FILE: &str = "sniffo-ca.key";

#[derive(Clone)]
pub struct RootCa {
    pub cert_pem: String,
    pub key_pem: String,
}

impl RootCa {
    /// Loads the CA from `dir`, generating and saving a new one if missing.
    pub fn load_or_create(dir: &Path) -> io::Result<Self> {
        let (cert, key) = (dir.join(CERT_FILE), dir.join(KEY_FILE));
        if cert.exists() && key.exists() {
            return Ok(Self { cert_pem: fs::read_to_string(cert)?, key_pem: fs::read_to_string(key)? });
        }
        let ca = Self::generate().map_err(io::Error::other)?;
        fs::create_dir_all(dir)?;
        fs::write(&cert, &ca.cert_pem)?;
        write_private(&key, &ca.key_pem)?;
        Ok(ca)
    }

    pub fn generate() -> Result<Self, hudsucker::rcgen::Error> {
        let key = KeyPair::generate()?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Sniffo Root CA");
        dn.push(DnType::OrganizationName, "Sniffo");
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        let now = std::time::SystemTime::now();
        params.not_before = now.into();
        params.not_after = (now + std::time::Duration::from_secs(10 * 365 * 24 * 3600)).into();
        let cert = params.self_signed(&key)?;
        Ok(Self { cert_pem: cert.pem(), key_pem: key.serialize_pem() })
    }

    pub fn issuer(&self) -> Result<Issuer<'static, KeyPair>, hudsucker::rcgen::Error> {
        Issuer::from_ca_cert_pem(&self.cert_pem, KeyPair::from_pem(&self.key_pem)?)
    }

    pub fn cert_der(&self) -> Vec<u8> {
        use hudsucker::rustls::pki_types::{CertificateDer, pem::PemObject};
        CertificateDer::from_pem_slice(self.cert_pem.as_bytes()).expect("CA cert is valid PEM").to_vec()
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &str) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?.write_all(data.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &str) -> io::Result<()> {
    fs::write(path, data)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let a = RootCa::load_or_create(dir.path()).unwrap();
        let b = RootCa::load_or_create(dir.path()).unwrap();
        assert_eq!(a.cert_pem, b.cert_pem);
        a.issuer().unwrap();
        let der = a.cert_der();
        assert_eq!(der[0], 0x30, "DER must start with SEQUENCE");
    }
}
