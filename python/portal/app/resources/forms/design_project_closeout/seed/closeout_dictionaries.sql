-- Design Project Close-Out dictionary seed.
-- The three flooding vocabularies (flooding_design_standards, flooding_impact,
-- flooding_service_eligibility) already exist in the catalog for the AIF form and are
-- reused by the close-out resource; only the two vocabularies below are new. Labels are
-- the exact strings stored and exported, taken from the close-out workbook template.
-- Idempotent: re-running inserts only what is missing.

INSERT OR IGNORE INTO SYS_DICTIONARIES (
    dictionary_key, name, description, is_active, created_at, updated_at
) VALUES (
    'source_of_analysis',
    'Source of Analysis',
    'Which team''s analysis produced a design project close-out record.',
    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'eng_major', 'Engineering Major', 1, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'source_of_analysis';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'eng_minor', 'Engineering Minor', 2, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'source_of_analysis';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'design', 'Design', 3, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'source_of_analysis';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'planning', 'Planning', 4, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'source_of_analysis';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'asset_mgmt', 'Asset Management', 5, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'source_of_analysis';

INSERT OR IGNORE INTO SYS_DICTIONARIES (
    dictionary_key, name, description, is_active, created_at, updated_at
) VALUES (
    'post_project_asset_condition',
    'Post Project Asset Condition',
    'Whether PACP 3+ defects or structure issues remain after project completion.',
    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'yes', 'Yes', 1, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'post_project_asset_condition';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'no', 'No', 2, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'post_project_asset_condition';
INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS (dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) SELECT id, 'not_inspected', 'Not Inspected', 3, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM SYS_DICTIONARIES WHERE dictionary_key = 'post_project_asset_condition';
