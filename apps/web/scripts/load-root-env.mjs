// Preload repository-root .env files before Next.js starts from apps/web.
import path from 'node:path';
import nextEnv from '@next/env';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const { loadEnvConfig } = nextEnv;

loadEnvConfig(repositoryRoot, process.env.NODE_ENV !== 'production');
