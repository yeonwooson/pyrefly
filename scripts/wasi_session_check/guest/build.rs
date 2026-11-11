fn main() {
    println!("cargo:rustc-link-arg=-zstack-size=8388608");
}
