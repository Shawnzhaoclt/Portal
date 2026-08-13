from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import duckdb

from . import source


class AssetHistorySourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.inventory = root / "inventory.db"
        self.step401 = root / "riskranking.db"
        self.cityworks = root / "cityworks.duckdb"
        self.cityworks_risk = root / "cityworks-risk.db"
        self.itpipes_intermediate = root / "itpipes.db"
        self.itpipes_production = root / "itpipes_stormwater_prod.duckdb"
        self.priority_pipes = root / "prioritypipes.db"
        self._build_inventory()
        self._build_step401()
        self._build_cityworks()
        self._build_cityworks_risk()
        self._build_itpipes()
        self._build_priority_pipes()
        self.config = {
            "sources": {
                "inventory": {"sourceId": "intermediate.inventory", "database": str(self.inventory)},
                "step401": {"sourceId": "intermediate.riskranking", "database": str(self.step401)},
                "cityworks": {"sourceId": "mirror.cityworks-workorder", "database": str(self.cityworks)},
                "cityworksRisk": {"sourceId": "intermediate.cityworks", "database": str(self.cityworks_risk)},
                "itpipesIntermediate": {"sourceId": "intermediate.itpipes", "database": str(self.itpipes_intermediate)},
                "itpipesProduction": {"sourceId": "mirror.itpipes", "database": str(self.itpipes_production)},
                "priorityPipes": {"sourceId": "intermediate.prioritypipes", "database": str(self.priority_pipes)},
            },
            "inventoryTables": {
                "structure": {"table": "STORMSTRUCTURE_1_PT", "idField": "ITPIPE_ASSETID", "entityType": "STRUCTURES"},
                "pipe": {"table": "STORMPIPES_1_LN", "idField": "ITPIPE_ASSETID", "entityType": "PIPES"},
                "channel": {"table": "STORMDRAINAGE_1_LN", "idField": "ITPIPE_ASSETID", "entityType": "CHANNELS"},
            },
            "step401Tables": {
                "cityworksUnassigned": "t_0001_UR_AC_CWOnly_All_Unassigned",
                "cityworksAssigned": "t_0004_UR_AC_CWOnly_Assigned_Or_Universal",
                "itpipesUnassigned": "t_0001_UR_AC_ITPipesOnly_All_Unassigned",
                "itpipesAssigned": "t_0004_UR_AC_ITPipesOnly_Assigned_Or_Universal",
                "assetIdField": "ITPIPE_ASSETID",
            },
            "cityworksTables": {
                "inspection": "azteca_INSPECTION",
                "inspectionQuestion": "azteca_INSPQUESTION",
                "workOrder": "azteca_WORKORDER",
                "workOrderEntity": "azteca_WORKORDERENTITY",
                "activityLink": "azteca_ACTIVITYLINK",
                "request": "azteca_REQUEST",
            },
            "cityworksRiskTables": {"scoredInspection": "CW_SCORED_ASSET_INSPECTIONS_ALL_PT"},
            "itpipesTables": {
                "defects": "ITPipes_Defects_Merged_PT",
                "inspection": "MLI",
                "asset": "ML",
            },
            "priorityPipesTables": {"scored": "PRIORITY_PIPES_SCORED"},
            "assetInspectionTemplatePattern": "%Asset Insp%",
        }
        self.config_patch = patch.object(source, "configured_asset_history", return_value=self.config)
        self.config_patch.start()

    def tearDown(self) -> None:
        self.config_patch.stop()
        self.temporary.cleanup()

    def _build_inventory(self) -> None:
        connection = duckdb.connect(str(self.inventory))
        for table in ("STORMSTRUCTURE_1_PT", "STORMPIPES_1_LN", "STORMDRAINAGE_1_LN"):
            connection.execute(f'CREATE TABLE "{table}" (ITPIPE_ASSETID VARCHAR, Active VARCHAR, Location VARCHAR, MATERIAL VARCHAR, US_ASSETID VARCHAR, DS_ASSETID VARCHAR)')
        connection.execute("INSERT INTO STORMPIPES_1_LN VALUES ('P_100', 'Active', 'Test Road', 'RCP', 'S_1', 'S_2')")
        connection.close()

    def _build_step401(self) -> None:
        connection = duckdb.connect(str(self.step401))
        for table in (
            "t_0001_UR_AC_CWOnly_All_Unassigned",
            "t_0004_UR_AC_CWOnly_Assigned_Or_Universal",
            "t_0001_UR_AC_ITPipesOnly_All_Unassigned",
            "t_0004_UR_AC_ITPipesOnly_Assigned_Or_Universal",
        ):
            connection.execute(f'CREATE TABLE "{table}" (ITPIPE_ASSETID VARCHAR, INSPECTIONID DOUBLE, WORKORDERID VARCHAR, REQUESTID DOUBLE, MLI_ID DOUBLE, MLO_ID DOUBLE)')
        connection.execute("INSERT INTO t_0004_UR_AC_CWOnly_Assigned_Or_Universal VALUES ('P_100', 10, '300', 1000, NULL, NULL)")
        connection.execute("INSERT INTO t_0001_UR_AC_ITPipesOnly_All_Unassigned VALUES ('P_100', NULL, NULL, NULL, 7, 70), ('P_100', NULL, NULL, NULL, 7, 71)")
        connection.close()

    def _build_cityworks(self) -> None:
        connection = duckdb.connect(str(self.cityworks))
        connection.execute("CREATE TABLE azteca_INSPECTION (INSPECTIONID DOUBLE, ENTITYUID VARCHAR, ENTITYTYPE VARCHAR, INSPTEMPLATENAME VARCHAR, INSPDATE TIMESTAMP, STATUS VARCHAR, REQUESTID DOUBLE, OBSERVATIONSUM VARCHAR, INSPECTEDBY VARCHAR, INITIATEDATE TIMESTAMP, DATECLOSED TIMESTAMP)")
        connection.execute("INSERT INTO azteca_INSPECTION VALUES (10, 'P_100', 'PIPES', 'Pipe Asset Inspection', '2026-01-02', 'Closed', 1000, 'Asset inspection', 'A', NULL, NULL), (20, NULL, NULL, 'Storm Water Investigation', '2026-01-03', 'Closed', 1001, 'Investigation', 'B', NULL, NULL), (21, NULL, NULL, 'Storm Water Investigation', '2026-01-04', 'Closed', NULL, 'Reverse investigation', 'B', NULL, NULL)")
        connection.execute("UPDATE azteca_INSPECTION SET INITIATEDATE='2026-01-01', DATECLOSED='2026-01-03' WHERE INSPECTIONID=10")
        connection.execute("CREATE TABLE azteca_INSPQUESTION (INSPQUESTIONID DOUBLE, INSPECTIONID DOUBLE, QUESTIONSEQUENCE DOUBLE, QUESTION VARCHAR, ANSWER VARCHAR)")
        connection.execute("INSERT INTO azteca_INSPQUESTION VALUES (1, 10, 1, 'Condition?', 'Good')")
        connection.execute("CREATE TABLE azteca_WORKORDER (WORKORDERID VARCHAR, DESCRIPTION VARCHAR, SUPERVISOR VARCHAR, INITIATEDBY VARCHAR, INITIATEDATE TIMESTAMP, PROJECTNAME VARCHAR, LOCATION VARCHAR, ACTUALSTARTDATE TIMESTAMP, DATEWOCLOSED TIMESTAMP, STATUS VARCHAR, PRIORITY VARCHAR)")
        connection.execute("INSERT INTO azteca_WORKORDER VALUES ('300', 'Repair pipe', 'C', 'D', '2026-01-04', 'Repair', 'Test Road', NULL, NULL, 'Open', 'High')")
        connection.execute("UPDATE azteca_WORKORDER SET ACTUALSTARTDATE='2026-01-04', DATEWOCLOSED='2026-01-10' WHERE WORKORDERID='300'")
        connection.execute("CREATE TABLE azteca_WORKORDERENTITY (WORKORDERID VARCHAR, ENTITYUID VARCHAR, ENTITYTYPE VARCHAR)")
        connection.execute("INSERT INTO azteca_WORKORDERENTITY VALUES ('300', 'P_100', 'PIPES')")
        connection.execute("CREATE TABLE azteca_ACTIVITYLINK (SOURCEACTIVITYTYPE VARCHAR, SOURCEACTIVITYID DOUBLE, DESTACTIVITYTYPE VARCHAR, DESTACTIVITYID DOUBLE, LINKTYPE VARCHAR)")
        connection.execute("INSERT INTO azteca_ACTIVITYLINK VALUES ('Inspection', 10, 'Inspection', 20, 'Related'), ('Inspection', 21, 'Inspection', 10, 'Related'), ('ServiceRequest', 1003, 'Inspection', 10, 'Related'), ('Inspection', 10, 'ServiceRequest', 1004, 'Related')")
        connection.execute("CREATE TABLE azteca_REQUEST (REQUESTID DOUBLE, PROBLEMCODE VARCHAR, DESCRIPTION VARCHAR, DETAILS VARCHAR, PRIORITY VARCHAR, PROBADDRESS VARCHAR, INITIATEDBY VARCHAR, DATETIMEINIT TIMESTAMP, DATETIMECLOSED TIMESTAMP, WORKORDERID VARCHAR, STATUS VARCHAR)")
        connection.execute("INSERT INTO azteca_REQUEST VALUES (1000, 'A', 'Inspection request', NULL, '1', 'Road', 'A', '2026-01-01', NULL, NULL, 'Open'), (1001, 'B', 'Investigation request', NULL, '2', 'Road', 'B', '2026-01-02', NULL, NULL, 'Closed'), (1002, 'C', 'Work order request', NULL, '3', 'Road', 'C', '2026-01-03', NULL, '300', 'Open'), (1003, 'D', 'Linked request', NULL, '4', 'Road', 'D', '2026-01-04', NULL, NULL, 'Open'), (1004, 'E', 'Reverse linked request', NULL, '5', 'Road', 'E', '2026-01-05', NULL, NULL, 'Open')")
        connection.execute("UPDATE azteca_REQUEST SET DATETIMECLOSED='2026-01-06' WHERE REQUESTID=1001")
        connection.close()

    def _build_cityworks_risk(self) -> None:
        connection = duckdb.connect(str(self.cityworks_risk))
        connection.execute(
            "CREATE TABLE CW_SCORED_ASSET_INSPECTIONS_ALL_PT (INSPECTIONID DOUBLE, COND_RISK DOUBLE, FLOOD_RISK DOUBLE, CLOG_RISK DOUBLE, RISK DOUBLE)"
        )
        connection.execute("INSERT INTO CW_SCORED_ASSET_INSPECTIONS_ALL_PT VALUES (10, 12.34, 5.67, 8.91, 26.92)")
        connection.close()

    def _build_itpipes(self) -> None:
        connection = duckdb.connect(str(self.itpipes_intermediate))
        connection.execute(
            """
            CREATE TABLE ITPipes_Defects_Merged_PT (
                ITPIPE_ASSETID VARCHAR,
                MLI_ID BIGINT,
                MLO_ID BIGINT,
                IS_CONTINUOUS BOOLEAN,
                Observation_Text VARCHAR,
                Distance DOUBLE,
                RELATIVE_DEPTH DOUBLE,
                COND_RISK DOUBLE,
                FLOOD_RISK DOUBLE,
                CLOG_RISK DOUBLE,
                RISK DOUBLE
            )
            """
        )
        connection.execute(
            """
            INSERT INTO ITPipes_Defects_Merged_PT VALUES
                ('P_100', 7, 70, false, 'Crack', 10.25, 2.75, 24.0, 3.1, 0.0, 27.1),
                ('P_100', 7, 71, true, 'Roots', 20.5, 3.25, 20.0, 2.0, 6.0, 28.0),
                ('P_100', 8, 80, false, 'Joint separation', 30.75, 4.5, 25.0, 4.0, 1.0, 30.0),
                ('P_200', 9, 90, false, 'Other asset', 40.0, 5.0, 40.0, 0.0, 0.0, 40.0)
            """
        )
        connection.execute("ALTER TABLE ITPipes_Defects_Merged_PT ADD COLUMN Detail_Only VARCHAR")
        connection.execute("UPDATE ITPipes_Defects_Merged_PT SET Detail_Only='Defect source detail' WHERE MLO_ID=80")
        connection.close()

        connection = duckdb.connect(str(self.itpipes_production))
        connection.execute(
            "CREATE TABLE ML (ML_ID BIGINT, ML_Name VARCHAR)"
        )
        connection.execute(
            "CREATE TABLE MLI (MLI_ID BIGINT, ML_ID BIGINT, Inspection_Date TIMESTAMP, Inspection_Direction VARCHAR)"
        )
        connection.execute("INSERT INTO ML VALUES (100, 'P_100'), (200, 'P_200')")
        connection.execute(
            """
            INSERT INTO MLI VALUES
                (7, 100, '2026-02-01 09:30:00', 'Upstream'),
                (8, 100, '2026-03-01 11:00:00', 'Downstream'),
                (9, 200, '2026-04-01 08:00:00', 'Upstream')
            """
        )
        connection.close()

    def _build_priority_pipes(self) -> None:
        connection = duckdb.connect(str(self.priority_pipes))
        connection.execute(
            """
            CREATE TABLE PRIORITY_PIPES_SCORED (
                ITPIPE_ASSETID VARCHAR,
                Basin_Name VARCHAR,
                WorkZoneID VARCHAR,
                CL_SCORE DOUBLE,
                LOF_SCORE DOUBLE,
                COF_SCORE DOUBLE,
                RISK DOUBLE
            )
            """
        )
        connection.execute(
            """
            INSERT INTO PRIORITY_PIPES_SCORED VALUES
                ('P_100', 'MCM', 'MCM522', 6, 4.7, 8.2, 38.54),
                ('P_200', 'IRW', 'IRW100', 2, 1.5, 3.0, 4.5)
            """
        )
        connection.execute("ALTER TABLE PRIORITY_PIPES_SCORED ADD COLUMN Detail_Only VARCHAR")
        connection.execute("UPDATE PRIORITY_PIPES_SCORED SET Detail_Only='Risk source detail' WHERE ITPIPE_ASSETID='P_100'")
        connection.close()

    def test_assignment_preserves_both_step401_branches(self) -> None:
        result = source.assignment_status("P_100")
        self.assertEqual("mixed", result["combined"])
        self.assertEqual("assigned", result["branches"]["cityworks"]["state"])
        self.assertEqual("unassigned", result["branches"]["itpipes"]["state"])
        self.assertEqual(["70", "71"], result["branches"]["itpipes"]["context"]["mlo_id"])
        self.assertEqual("assigned", source.binary_assignment_status(result))

    def test_binary_assignment_uses_assigned_precedence(self) -> None:
        self.assertEqual("assigned", source.binary_assignment_status({"branches": {"cityworks": {"state": "unassigned"}, "itpipes": {"state": "assigned"}}}))
        self.assertEqual("unassigned", source.binary_assignment_status({"branches": {"cityworks": {"state": "unassigned"}, "itpipes": {"state": "not_evaluated"}}}))
        self.assertEqual("data_unavailable", source.binary_assignment_status({"branches": {"cityworks": {"state": "not_evaluated"}, "itpipes": {"state": "data_conflict"}}}))

    def test_history_preserves_all_relationship_paths(self) -> None:
        result = source.activity_history("pipe", "P_100")
        self.assertEqual(1, len(result["inspections"]))
        self.assertEqual(12.34, result["inspections"][0]["condition_risk"])
        self.assertEqual(5.67, result["inspections"][0]["flood_risk"])
        self.assertEqual(8.91, result["inspections"][0]["clogging_risk"])
        self.assertEqual(26.92, result["inspections"][0]["risk"])
        self.assertEqual(2, len(result["investigations"]))
        self.assertEqual(1, len(result["work_orders"]))
        self.assertEqual({"1000", "1001", "1002", "1003", "1004"}, {row["record_id"] for row in result["service_requests"]})

    def test_timeline_expands_lifecycle_dates_and_collapses_matching_timestamps(self) -> None:
        events = source.timeline_events(source.activity_history("pipe", "P_100"))
        self.assertEqual(13, len(events))
        self.assertEqual("2026-01-10T00:00:00", events[0]["event_date"])
        work_order_start = next(
            event for event in events
            if event["kind"] == "work_order" and event["event_date"] == "2026-01-04T00:00:00"
        )
        self.assertEqual("Initiated · Started", work_order_start["event_name"])
        self.assertEqual(["INITIATEDATE", "ACTUALSTARTDATE"], work_order_start["event_fields"])
        self.assertTrue(work_order_start["event_key"].startswith("work_order:300:"))

    def test_search_and_summary_use_inventory_only(self) -> None:
        self.assertEqual("P_100", source.search_assets("P_10")[0]["asset_id"])
        result = source.asset_summary("pipe", "P_100")
        self.assertEqual("PIPES", result["entity_type"])
        self.assertEqual("RCP", result["summary"]["MATERIAL"])

    def test_itpipes_defects_use_merged_risks_and_production_inspection_context(self) -> None:
        self.assertEqual(3, source.itpipes_defect_count("P_100"))
        result = source.itpipes_defects("P_100")
        self.assertEqual(["80", "70", "71"], [row["mlo_id"] for row in result])
        self.assertEqual("8", result[0]["mli_id"])
        self.assertEqual("100", result[0]["ml_id"])
        self.assertEqual("2026-03-01T11:00:00", result[0]["inspection_date"])
        self.assertEqual("Downstream", result[0]["inspection_direction"])
        self.assertEqual("Joint separation", result[0]["observation_text"])
        self.assertEqual(30.75, result[0]["distance"])
        self.assertEqual(4.5, result[0]["relative_depth"])
        self.assertEqual(25.0, result[0]["condition_risk"])
        self.assertFalse(result[0]["is_continuous"])
        self.assertEqual("Defect source detail", result[0]["source_attributes"]["Detail_Only"])

    def test_priority_pipe_risk_uses_published_scored_table(self) -> None:
        self.assertEqual(1, source.priority_pipe_risk_count("P_100"))
        result = source.priority_pipe_risk("P_100")
        self.assertEqual(1, len(result))
        self.assertEqual("MCM", result[0]["basin_name"])
        self.assertEqual("MCM522", result[0]["work_zone_id"])
        self.assertEqual(6.0, result[0]["cl_score"])
        self.assertEqual(4.7, result[0]["lof_score"])
        self.assertEqual(8.2, result[0]["cof_score"])
        self.assertEqual(38.54, result[0]["risk"])
        self.assertEqual("Risk source detail", result[0]["source_attributes"]["Detail_Only"])

    def test_non_cityworks_details_return_all_source_fields(self) -> None:
        defect = source.record_detail("itpipes_defect", "80")
        self.assertEqual("Defect source detail", defect["fields"]["Detail_Only"])
        self.assertEqual(80, defect["fields"]["MLO_ID"])

        risk = source.record_detail("pipe_risk", "P_100", work_zone_id="MCM522")
        self.assertEqual("Risk source detail", risk["fields"]["Detail_Only"])
        self.assertEqual("MCM522", risk["fields"]["WorkZoneID"])


if __name__ == "__main__":
    unittest.main()
