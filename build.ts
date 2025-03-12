try {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
  })
  if (result.success) {
    console.log("Build success.", result.outputs[0].path)
  }
} catch (err) {
  const error = err as AggregateError
  console.error("Build Failed")
  console.error(error)
}
