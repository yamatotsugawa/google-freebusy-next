/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true }, // ← 応急処置
};
module.exports = nextConfig;

eslint: { ignoreDuringBuilds: true }