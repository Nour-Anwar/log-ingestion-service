import type { Request, Response } from "express";
import { sql } from "../db/client.js";
import {
  parseAggregateQuery
} from "./aggregateValidate.js";



function bucketToInterval(
  bucket: string
) {

  switch(bucket){

    case "1m":
      return "1 minute";

    case "5m":
      return "5 minutes";

    case "1h":
      return "1 hour";

    case "1d":
      return "1 day";

    default:
      throw new Error("invalid bucket");
  }

}




export async function aggregateLogs(
  req: Request,
  res: Response
){

  try {


    const params =
      parseAggregateQuery(
        req.query as Record<string, unknown>
      );



    const interval =
      bucketToInterval(
        params.bucket
      );



    let rows;



    if(params.groupBy === "service"){


      rows = await sql`

        SELECT
          date_bin(
            ${interval},
            ts,
            TIMESTAMP '2001-01-01'
          ) AS start,

          service AS group,

          COUNT(*)::int AS count

        FROM logs

        WHERE ts >= ${params.since}
        AND ts < ${params.until}

        GROUP BY start, service

        ORDER BY start;

      `;


    }
    else if(params.groupBy === "level"){


      rows = await sql`

        SELECT
          date_bin(
            ${interval},
            ts,
            TIMESTAMP '2001-01-01'
          ) AS start,

          level AS group,

          COUNT(*)::int AS count

        FROM logs

        WHERE ts >= ${params.since}
        AND ts < ${params.until}

        GROUP BY start, level

        ORDER BY start;

      `;



    }
    else {


      rows = await sql`

        SELECT

          date_bin(
            ${interval},
            ts,
            TIMESTAMP '2001-01-01'
          ) AS start,

          COUNT(*)::int AS count


        FROM logs


        WHERE ts >= ${params.since}
        AND ts < ${params.until}


        GROUP BY start

        ORDER BY start;

      `;

    }



    return res.status(200).json({
      buckets: rows,
    });



  }
  catch(error){

    return res.status(400).json({
      error:(error as Error).message
    });

  }

}