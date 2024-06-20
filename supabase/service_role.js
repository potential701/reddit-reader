import { createClient } from '@supabase/supabase-js';
import { StorageClient } from '@supabase/storage-js';

export async function createServiceClient() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE
  );

  return supabase;
}

export async function createStorageClient() {
  const storageUrl = `${process.env.SUPABASE_URL}/storage/v1`;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE;
  const storageClient = new StorageClient(storageUrl, {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  });

  return storageClient;
}
