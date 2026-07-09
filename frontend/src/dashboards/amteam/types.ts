export type AmTeamCellValue = string | number | boolean | null

export type AmTeamMediaAsset = {
  name: string
  kind: 'snapshot' | 'video' | 'report'
  relative_path: string
  url: string
  media_type: string | null
  duration_seconds?: number | null
  frame_count?: number | null
  fps?: number | null
}

export type AmTeamInspectionMedia = {
  media_root: string
  pipe_folder: string | null
  inspection_folder: string | null
  date_prefix: string | null
  snapshots: AmTeamMediaAsset[]
  videos: AmTeamMediaAsset[]
  reports: AmTeamMediaAsset[]
  warnings: string[]
}

export type AmTeamPipe = {
  ml_id: AmTeamCellValue
  ml_name: AmTeamCellValue
  project_title: AmTeamCellValue
  street: AmTeamCellValue
  us_mh: AmTeamCellValue
  ds_mh: AmTeamCellValue
  material: AmTeamCellValue
  pipe_shape: AmTeamCellValue
  pipe_height: AmTeamCellValue
}

export type AmTeamInspection = {
  ml_id: AmTeamCellValue
  ml_name: AmTeamCellValue
  project_title: AmTeamCellValue
  street: AmTeamCellValue
  us_mh: AmTeamCellValue
  ds_mh: AmTeamCellValue
  material: AmTeamCellValue
  pipe_shape: AmTeamCellValue
  pipe_height: AmTeamCellValue
  mli_id: AmTeamCellValue
  operator: AmTeamCellValue
  inspection_date: AmTeamCellValue
  reason_of_inspection: AmTeamCellValue
  inspection_direction: AmTeamCellValue
  inspection_length: AmTeamCellValue
  inspection_status: AmTeamCellValue
  current_status: AmTeamCellValue
}

export type AmTeamObservation = {
  mlo_id: AmTeamCellValue
  mli_id: AmTeamCellValue
  distance: AmTeamCellValue
  code: AmTeamCellValue
  observation_text: AmTeamCellValue
  grade: AmTeamCellValue
  continuous: AmTeamCellValue
  joint: AmTeamCellValue
  value_percent: AmTeamCellValue
  remarks: AmTeamCellValue
  clock_from: AmTeamCellValue
  clock_to: AmTeamCellValue
  vcr_time: AmTeamCellValue
  digital_time: AmTeamCellValue
  media_id: AmTeamCellValue
  full_path: AmTeamCellValue
  image_url: string | null
  image_urls: string[]
  image_available: boolean
}

export type AmTeamPipeSearchResponse = {
  query: string
  rows: AmTeamPipe[]
}

export type AmTeamPipeInspectionGroup = AmTeamPipe & {
  inspections: AmTeamInspection[]
}

export type AmTeamPipeInspectionGroupResponse = {
  query: string
  kind?: string | null
  rows: AmTeamPipeInspectionGroup[]
}

export type AmTeamInspectionResponse = {
  ml_id: string
  rows: AmTeamInspection[]
}

export type AmTeamInspectionSearchResponse = {
  query: string
  pipe_count: number
  rows: AmTeamInspection[]
}

export type AmTeamObservationResponse = {
  mli_id: string
  media: AmTeamInspectionMedia
  rows: AmTeamObservation[]
}
