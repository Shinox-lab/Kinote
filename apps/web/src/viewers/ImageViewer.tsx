import { useEffect, useState } from 'react';

/** An image shown from an object URL (so no token is in the address); revoked when the viewer goes away. */
export default function ImageViewer({ bytes, mimeType, name }: { bytes: ArrayBuffer; mimeType: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, mimeType]);
  if (!url) return null;
  return <div className="flex justify-center"><img src={url} alt={name} className="max-h-[75vh] max-w-full object-contain" /></div>;
}
