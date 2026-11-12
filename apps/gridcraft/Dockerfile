FROM alpine:3.20 AS fetch
ARG GRIDCRAFT_VERSION=0.19.1
ARG GRIDCRAFT_SHA256=48c5d1b101befebb3c5ba3b7a14914f01c3207934813ed07dc4251b7ae116a78
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/gridcraft.zip \
    "https://github.com/storytold/gridcraft/releases/download/v${GRIDCRAFT_VERSION}/gridcraft-web-${GRIDCRAFT_VERSION}.zip" \
 && echo "${GRIDCRAFT_SHA256}  /tmp/gridcraft.zip" | sha256sum -c - \
 && unzip -q /tmp/gridcraft.zip -d /tmp/gridcraft \
 && mv "/tmp/gridcraft/gridcraft-web-${GRIDCRAFT_VERSION}" /site

FROM nginx:1.27-alpine
# The release (X.Y.Z), set by the release workflow; empty in a build from source.
ARG KINOTE_VERSION=
ENV KINOTE_VERSION=${KINOTE_VERSION}
LABEL org.opencontainers.image.version=${KINOTE_VERSION}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=fetch /site /usr/share/nginx/html
EXPOSE 80
