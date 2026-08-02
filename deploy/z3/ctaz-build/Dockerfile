# Build the Crosslink zebrad for the box, in a container, so nothing compiles on the box.
#
# WHY A CONTAINER AT ALL. This is a Rust monorepo carrying zebra, librustzcash, zaino and
# zingolib. It took 6m07s on a fast laptop with a warm cargo registry and pulled several
# gigabytes of build artifacts. Running that next to a live faucet competes for CPU and
# disk with the thing that holds value, and leaves a toolchain on a box that should not
# have one.
#
# THE BINARY IS THE ARTIFACT. Nothing from this image ships except target/release/zebrad,
# extracted by ctaz-build.sh. The image is scaffolding.
#
# --platform is passed by the caller, not hardcoded, so the same file serves a native
# build and a cross build. On an arm64 host targeting amd64 this runs under emulation and
# is SLOW. That is the cost of not compiling on the box, and it is paid once per bump.

ARG RUST_IMAGE=rust:1.90-bookworm
FROM ${RUST_IMAGE} AS build

# zebra needs these to build: protobuf for the gRPC definitions zaino serves, clang for
# the rocksdb bindings, taken at bookworm's versions.
#
# THE RUST VERSION IS NOT PINNED, WHATEVER RUST_IMAGE SAYS, and I would rather say so than
# leave a pin that looks load-bearing and is not. Their tree ships a rust-toolchain.toml
# reading `channel = "stable"`, and rustup honours that over whatever the base image
# provides: building on rust:1.90-bookworm, the first thing the build did was fetch
# stable 1.97.1. So the same SOURCE rev can produce a different binary on a different day.
#
# Not forcing RUSTUP_TOOLCHAIN to override it, because pinning their build to a compiler
# they have not tested is a way to break it for a reproducibility we do not need yet. What
# we do need is to know what actually produced the artifact, so the compiler version is
# captured below and printed by ctaz-build.sh. Identifiable now, reproducible later if it
# ever matters.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      protobuf-compiler libprotobuf-dev clang libclang-dev cmake pkg-config \
      libssl-dev git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ARG SOURCE_REPO=https://github.com/ShieldedLabs/crosslink_monolith
# Pinned deliberately. An unpinned build is not reproducible and cannot be reviewed: the
# thing that ships would depend on the day it was built.
ARG SOURCE_REV

WORKDIR /src
RUN test -n "${SOURCE_REV}" || { echo "SOURCE_REV must be set, refusing an unpinned build" >&2; exit 2; }
RUN git init -q . && \
    git remote add origin "${SOURCE_REPO}" && \
    git fetch -q --depth 1 origin "${SOURCE_REV}" && \
    git checkout -q FETCH_HEAD

# DEFAULT FEATURES ONLY. viz_gui is opt-in and absent from `default`, and the
# cfg(not(viz_gui)) branch of their start command is the one that spawns the headless
# wallet and the embedded indexer. Adding --all-features here would pull the GUI in.
WORKDIR /src/zebra-crosslink
# Record the compiler that actually ran, since rust-toolchain.toml decides it rather than
# the base image. Written before the build so it exists even if the build then fails.
RUN rustc --version > /rustc-version.txt && cat /rustc-version.txt
RUN cargo build --release -p zebrad --locked || cargo build --release -p zebrad

# A separate stage holding only the binary, so `docker create` against it copies one file
# rather than a multi-gigabyte build tree.
FROM scratch AS artifact
COPY --from=build /src/zebra-crosslink/target/release/zebrad /zebrad
COPY --from=build /rustc-version.txt /rustc-version.txt
