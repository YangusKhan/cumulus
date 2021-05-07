export interface PostgresCollection {
  name: string,
  version: string,
  granule_id_validation_regex: string,
  granule_id_extraction_regex: string,
  files: string,
  process?: string,
  duplicate_handling?: string,
  report_to_ems?: boolean,
  sample_file_name?: string,
  url_path?: string,
  ignore_files_config_for_discovery?: boolean,
  meta?: string,
  tags?: string,
  created_at?: Date,
  updated_at?: Date,
}

export interface PostgresCollectionRecord extends PostgresCollection {
  cumulus_id: number,
  created_at: Date,
  updated_at: Date,
}
