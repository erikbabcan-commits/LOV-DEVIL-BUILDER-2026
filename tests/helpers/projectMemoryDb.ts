import { DataType, type IMemoryDb } from 'pg-mem';

/** pg-mem lacks this standard PostgreSQL function. Native PG tests remain the
 * authority for JSONB text formatting, transaction rollback and row locks. */
export function registerProjectByteLength(mem: IMemoryDb): void {
  mem.public.registerFunction({ name: 'octet_length', args: [DataType.text], returns: DataType.integer,
    implementation: (value: string) => Buffer.byteLength(value, 'utf8') });
}
