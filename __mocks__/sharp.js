module.exports = () => ({
  ensureAlpha: () => ({
    removeAlpha: () => ({
      raw: () => ({
        toBuffer: async () => ({ data: Buffer.alloc(0), info: { width: 0, height: 0, channels: 3 } }),
      }),
    }),
  }),
  metadata: async () => ({ width: 0, height: 0, channels: 3 }),
});
