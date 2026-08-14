-- idx_logs_attrs (GIN, 0000_init.sql) is the most expensive index to
-- maintain and was defined on the partitioned parent, meaning every
-- new partition — including today's active, write-heavy partition —
-- inherited it automatically. We now build it only on sealed
-- (non-active) partitions, mirroring ensureMessageIndexesOnSealedPartitions.
DROP INDEX IF EXISTS idx_logs_attrs;
