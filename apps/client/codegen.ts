import type { CodegenConfig } from '@graphql-codegen/cli'

/**
 * Codegen input: the live server schema plus the documents that live next to
 * the feature that owns them. Output goes to `src/graphql/` and is gitignored —
 * it is a build artefact, regenerated from `apps/server/schema.graphql` (which
 * `createApp` rewrites on every server boot) whenever that schema changes.
 */
const config: CodegenConfig = {
  schema: '../server/schema.graphql',
  documents: ['src/features/**/graphql/**/*.{ts,tsx}', '!src/graphql/**'],
  ignoreNoDocuments: true,
  generates: {
    'src/graphql/': {
      preset: 'client',
      presetConfig: {
        fragmentMasking: false,
      },
      config: {
        // DateTimeISO is a graphql-scalar string on the wire (RFC 3339); the
        // default `any` mapping would throw away the type on every field that
        // uses it.
        scalars: {
          DateTimeISO: 'string',
        },
        useTypeImports: true,
        withHooks: true,
        withComponent: false,
        withHOC: false,
        reactApolloVersion: 4,
      },
    },
  },
}

export default config
