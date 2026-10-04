import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function clientFor(endpoint: string) {
  return new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "daftar",
      secretAccessKey: process.env.S3_SECRET_KEY || "daftar-local-only",
    },
  });
}

const uploadEndpoint = () => process.env.S3_ENDPOINT || "http://127.0.0.1:59000";
const publicEndpoint = () => process.env.S3_PUBLIC_ENDPOINT || uploadEndpoint();

export async function putObject(key: string, body: Buffer, contentType: string) {
  await clientFor(uploadEndpoint()).send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || "statements",
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const out = await clientFor(uploadEndpoint()).send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET || "statements",
      Key: key,
    }),
  );
  const body = out.Body;
  if (!body) return Buffer.alloc(0);
  const arr = await body.transformToByteArray();
  return Buffer.from(arr);
}

export async function signedGetUrl(key: string) {
  return getSignedUrl(
    clientFor(publicEndpoint()),
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET || "statements",
      Key: key,
    }),
    { expiresIn: 300 },
  );
}
