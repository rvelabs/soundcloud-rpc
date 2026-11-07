use base64::Engine;
use minisign_verify::{PublicKey, Signature};

#[test]
#[ignore = "requires SOUNDCLOUD_NATIVE_SIGNED_PACKAGE from a completed local bundle"]
fn signed_installer_matches_the_embedded_key_and_release_version() {
    let path = std::env::var("SOUNDCLOUD_NATIVE_SIGNED_PACKAGE").expect("Set the installer path");
    let decode = |text: &str| {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .unwrap(),
        )
        .unwrap()
    };
    let public = PublicKey::decode(&decode(include_str!("../updater.pub"))).unwrap();
    let signature = Signature::decode(&decode(
        &std::fs::read_to_string(format!("{path}.sig")).unwrap(),
    ))
    .unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.is_empty());
    public.verify(&bytes, &signature, true).unwrap();
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .expect("Release version must be signed");
    assert_eq!(
        semver::Version::parse(signed_version).unwrap(),
        semver::Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
    );
    bytes[0] ^= 1;
    assert!(
        public.verify(&bytes, &signature, true).is_err(),
        "a modified installer must be rejected"
    );
}
