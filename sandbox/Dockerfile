# The image every piece of user code runs in. One small Alpine image with all
# three toolchains, so there is a single thing to build and reason about.
#
# WHY no code is baked in: the image is read-only at run time; the user's
# program arrives on stdin and is written to an in-memory /tmp that disappears
# with the container.
FROM alpine:3.21
RUN apk add --no-cache python3 nodejs g++
# WHY a non-root user: even if a program escapes the language runtime it has
# no root privileges inside the container (and all capabilities are dropped
# by the `docker run` flags in server/src/sandbox.ts).
USER 1000:1000
WORKDIR /tmp
