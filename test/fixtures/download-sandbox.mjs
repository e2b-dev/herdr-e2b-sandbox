import { appendFile, readFile } from "node:fs/promises"
import { Sandbox } from "e2b"

const fixture = JSON.parse(await readFile(process.env.HERDR_TEST_DOWNLOAD_FIXTURE, "utf8"))
globalThis.fetch = async () => { throw new Error("network access is forbidden in download tests") }

Sandbox.connect = async () => ({
  commands: {
    run: async () => ({ stdout: fixture.files.map((file) => ` M ${file.path}\0`).join("") }),
  },
  files: {
    read: async (remotePath) => {
      const rel = remotePath.slice("/home/user/project/".length)
      const file = fixture.files.find((file) => file.path === rel)
      const previous = await readFile(fixture.reads, "utf8")
      await appendFile(fixture.reads, `${rel}\n`)
      if (file.error && (!file.failOnce || !previous.split("\n").includes(rel))) {
        throw new Error(file.error)
      }
      return Buffer.from(file.data ?? "remote content")
    },
  },
})
