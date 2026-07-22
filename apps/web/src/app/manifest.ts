import type { MetadataRoute } from 'next';
import {
  productDescription,
  productName,
} from '@/lib/brand';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: productName,
    short_name: productName,
    description: productDescription,
    start_url: '/',
    display: 'standalone',
    background_color: '#e9eff1',
    theme_color: '#020617',
  };
}
