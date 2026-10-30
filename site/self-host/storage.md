# Object storage

Uploaded files are stored in S3-compatible object storage. The database keeps track of them; the bytes live in the
bucket.

## The bundled MinIO

By default, Compose runs MinIO next to Kinote and uses it. `S3_ACCESS_KEY` and `S3_SECRET_KEY` are both Kinote's
credentials and MinIO's admin login. MinIO's console is on `http://localhost:59001` (`MINIO_CONSOLE_HOST_PORT`).

Its data lives in the Docker volume `kinote_miniodata`.

## An external S3 store

To use AWS S3 or another S3-compatible service instead, set:

```sh
S3_ENDPOINT=https://s3.your-provider.example
S3_BUCKET=kinote
S3_ACCESS_KEY=<access key>
S3_SECRET_KEY=<secret key>
S3_REGION=<region>
```

Kinote creates the bucket when it starts if it doesn't exist yet. The MinIO container still starts, but Kinote no
longer uses it.

## Upload limits

`MAX_UPLOAD_BYTES` caps one upload (50 MB by default, at most 500 MB). See [Configuration](./configuration#files).
