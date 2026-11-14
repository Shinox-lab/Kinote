FROM alpine:3.20 AS fetch
ARG GRIDCRAFT_VERSION=0.19.1
ARG GRIDCRAFT_SHA256=48c5d1b101befebb3c5ba3b7a14914f01c3207934813ed07dc4251b7ae116a78
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/gridcraft.zip \
    "https://github.com/storytold/gridcraft/releases/download/v${GRIDCRAFT_VERSION}/gridcraft-web-${GRIDCRAFT_VERSION}.zip" \
 && echo "${GRIDCRAFT_SHA256}  /tmp/gridcraft.zip" | sha256sum -c - \
 && unzip -q /tmp/gridcraft.zip -d /tmp/gridcraft \
 && mv "/tmp/gridcraft/gridcraft-web-${GRIDCRAFT_VERSION}" /site

# host.html is the release's own index.html with the canvas switched to page
# host mode, plus the relay that carries its events to the sandboxed frame's
# parent (see host-relay.js). The edits fail the build if the release's markup
# is not what they expect.
COPY host-relay.js /site/host-relay.js
RUN chmod 644 /site/host-relay.js \
 && sed -e 's|<canvas id="gridcraft_canvas">|<canvas id="gridcraft_canvas" data-host="page">|' \
        -e 's|</body>|<script src="./host-relay.js"></script></body>|' \
        /site/index.html > /site/host.html \
 && grep -q 'data-host="page"' /site/host.html \
 && grep -q 'host-relay.js' /site/host.html

FROM nginx:1.27-alpine
# The release (X.Y.Z), set by the release workflow; empty in a build from source.
ARG KINOTE_VERSION=
ENV KINOTE_VERSION=${KINOTE_VERSION}
LABEL org.opencontainers.image.version=${KINOTE_VERSION}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=fetch /site /usr/share/nginx/html
EXPOSE 80
