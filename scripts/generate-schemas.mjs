import fs from 'fs';
import path from 'node:path';
import {createGenerator} from 'ts-json-schema-generator';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'schema'); // ship these files in the pkg
fs.mkdirSync(OUT_DIR, {recursive: true});

/** Helpers */
function writeSchema(filename, schema) {
    const file = path.join(OUT_DIR, filename);
    fs.writeFileSync(file, JSON.stringify(schema, null, 2));
    console.log('✔︎ schema ->', path.relative(ROOT, file));
}

/** Common generator config */
const baseConfig = {
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    // expose all exported types – we’ll pick specific ones per call
    expose: 'export',
    topRef: true,
    additionalProperties: true,
    skipTypeCheck: false
};

/** 1) ServiceProps (runtime) */
{
    const gen = createGenerator({...baseConfig, path: 'src/schema/index.ts', type: 'ServiceProps'});
    const schema = gen.createSchema('ServiceProps');
    // Patch: require component when Field.type === 'custom'
    if (schema?.$defs?.Field) {
        schema.$defs.Field.allOf = [
            ...(schema.$defs.Field.allOf || []),
            {
                if: {properties: {type: {const: 'custom'}}, required: ['type']},
                then: {required: ['component']}
            }
        ];
    }
    writeSchema('service-props.schema.json', schema);
}

/** 2) EditorSnapshot (authoring only) */
{
    const gen = createGenerator({...baseConfig, path: 'src/schema/editor.ts', type: 'EditorSnapshot'});
    const schema = gen.createSchema('EditorSnapshot');
    writeSchema('editor-snapshot.schema.json', schema);
}


// scripts/generate-schemas.mjs (add after editor-snapshot block)

{
    const gen = createGenerator({
        ...baseConfig,
        path: 'src/schema/policies.ts',
        type: 'AdminPolicies', // top-level array
    });
    const schema = gen.createSchema('AdminPolicies');

    // Optional: patch to enforce projection to start with "service."
    // (ts-json-schema-generator can't infer this constraint)
    if (schema?.$defs?.DynamicRule?.properties?.projection) {
        const proj = schema.$defs.DynamicRule.properties.projection;
        // Projection is optional string; add a pattern if provided
        proj.pattern = '^service\\..+';
        // Also improve "op", "scope", "subject" enums (defensive)
        const R = schema.$defs.DynamicRule;
        if (R.properties?.op) {
            R.properties.op.enum = ['all_equal', 'unique', 'no_mix', 'all_true', 'any_true', 'max_count', 'min_count'];
        }
        if (R.properties?.scope) {
            R.properties.scope.enum = ['global', 'visible_group'];
        }
        if (R.properties?.subject) {
            R.properties.subject.enum = ['services'];
        }
        // filter.role enum
        if (R.properties?.filter?.properties?.role) {
            R.properties.filter.properties.role.enum = ['base', 'utility', 'both'];
        }
        // severity enum
        if (R.properties?.severity) {
            R.properties.severity.enum = ['error', 'warning'];
        }
    }

    writeSchema('policies.schema.json', schema);
}