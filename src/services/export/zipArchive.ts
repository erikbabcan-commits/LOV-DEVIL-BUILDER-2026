import JSZip from 'jszip';

export interface ZipArchiveFile {
  path: string;
  content: string;
}

/** Environment-neutral ZIP builder shared by browser download and clean-room verification. */
export async function buildZipBlob(files: ZipArchiveFile[], readme: string): Promise<Blob> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  zip.file('README.md', readme);
  return zip.generateAsync({ type: 'blob' });
}
