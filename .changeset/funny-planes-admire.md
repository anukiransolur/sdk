---
"@tailor-platform/sdk": minor
---

Add `toResolverOutput` function to convert TailorDBType to resolver output field

- `toResolverOutput(type)` converts a TailorDBType to `t.object(type.fields).typeName(type.name)`
- Simplifies using TailorDB types as resolver outputs with proper type names
