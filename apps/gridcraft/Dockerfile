FROM alpine:3.20 AS fetch
ARG GRIDCRAFT_VERSION=0.13.0
ARG GRIDCRAFT_SHA256=e232edde1898459f13568ca7b1f3feecb4037f0cbb8f6aec86de1a3c096af5dc
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/gridcraft.zip \
    "https://github.com/storytold/gridcraft/releases/download/v${GRIDCRAFT_VERSION}/gridcraft-web-${GRIDCRAFT_VERSION}.zip" \
 && echo "${GRIDCRAFT_SHA256}  /tmp/gridcraft.zip" | sha256sum -c - \
 && unzip -q /tmp/gridcraft.zip -d /tmp/gridcraft \
 && mv "/tmp/gridcraft/gridcraft-web-${GRIDCRAFT_VERSION}" /site

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=fetch /site /usr/share/nginx/html
EXPOSE 80
