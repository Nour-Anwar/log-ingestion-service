import type { Request, Response } from "express";
import { parseLogQuery } from "./queryValidate.js";
import { queryLogs } from "./query.js";


export async function listLogs(
  req:Request,
  res:Response
){

  try{

    const params =
      parseLogQuery(
        req.query as Record<string,unknown>
      );


    const result =
      await queryLogs(params);



    return res.json({
      logs: result.logs,
      next_cursor: result.nextCursor,
    });


  }
  catch(error){

    return res.status(400).json({
      error:(error as Error).message
    });

  }

}